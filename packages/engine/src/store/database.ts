import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CourseTree, ImportEstimate, MasteryRecord, RepositoryAnalysis, RepositoryIndex, ReviewSchedule } from "@codebase-tutor/shared";
import { loadAddon } from "./betterSqlite3Loader.cjs";

const schemaVersion = 5;

// 一次性 pre-load：dlopen 对应当前 Node ABI 的 binding 路径，避免 better-sqlite3
// 走默认 `bindings('better_sqlite3.node')` 触发 127↔147 mismatch。
// 后端只需 `new Database(filename, { nativeBinding })` 即可。
// 类型 cast 是因为 @types/better-sqlite3 只声明了 `nativeBinding: string`，但
// runtime 接受 addon 对象（见 better-sqlite3/lib/database.js 注释 "string or addon object"）。
const nativeBinding = loadAddon() as unknown as string;

/** layer_cache 的按龄修剪线：键是输入精确哈希，过期条目只是占空间的垃圾，不存在「过期还在被信任」。 */
const LAYER_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export class TutorDatabase {
  private readonly db: Database.Database;

  constructor(readonly repositoryPath: string) {
    const tutorDir = join(repositoryPath, ".tutor");
    if (!existsSync(tutorDir)) mkdirSync(tutorDir, { recursive: true });
    this.db = new Database(join(tutorDir, "tutor.db"), { nativeBinding });
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_state (
        repository_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        index_json TEXT,
        course_json TEXT,
        estimate_json TEXT,
        analysis_json TEXT,
        settings_json TEXT
      );
      CREATE TABLE IF NOT EXISTS summaries (
        cache_key TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exercise_cache (
        repository_id TEXT NOT NULL,
        content_version TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_unit_id TEXT NOT NULL,
        exercise_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(repository_id, content_version, kind, target_unit_id)
      );
      CREATE TABLE IF NOT EXISTS learner_mastery (
        repository_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        mastery_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(repository_id, unit_id)
      );
      CREATE TABLE IF NOT EXISTS review_schedule (
        repository_id TEXT NOT NULL,
        exercise_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(repository_id, exercise_id)
      );
      CREATE TABLE IF NOT EXISTS layer_cache (
        cache_key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `);
    const current = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
    if (!current) {
      this.db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(schemaVersion);
      return;
    }
    if (current.version < 2) {
      this.db.exec("ALTER TABLE repository_state ADD COLUMN analysis_json TEXT;");
      this.db.exec("ALTER TABLE repository_state ADD COLUMN settings_json TEXT;");
      this.db.prepare("UPDATE schema_version SET version = ?").run(2);
    }
    if (current.version < 3) this.db.prepare("UPDATE schema_version SET version = ?").run(3);
    if (current.version < 4) this.db.prepare("UPDATE schema_version SET version = ?").run(4);
    if (current.version < 5) this.db.prepare("UPDATE schema_version SET version = ?").run(schemaVersion);
    if (current.version > schemaVersion) {
      throw new Error(`Unsupported .tutor schema version ${current.version}`);
    }
  }

  saveIndex(index: RepositoryIndex): void {
    this.upsert(index.repositoryId, { index: JSON.stringify(index) });
  }

  saveCourse(tree: CourseTree, estimate: ImportEstimate): void {
    this.upsert(tree.repositoryId, { course: JSON.stringify(tree), estimate: JSON.stringify(estimate) });
  }

  saveAnalysis(analysis: RepositoryAnalysis): void {
    this.upsert(analysis.repositoryId, { analysis: JSON.stringify(analysis) });
  }

  getIndex(repositoryId: string): RepositoryIndex | undefined {
    const state = this.getState(repositoryId);
    return state?.index_json ? JSON.parse(state.index_json) as RepositoryIndex : undefined;
  }

  getCourse(repositoryId: string): CourseTree | undefined {
    const state = this.getState(repositoryId);
    return state?.course_json ? JSON.parse(state.course_json) as CourseTree : undefined;
  }

  getEstimate(repositoryId: string): ImportEstimate | undefined {
    const state = this.getState(repositoryId);
    return state?.estimate_json ? JSON.parse(state.estimate_json) as ImportEstimate : undefined;
  }

  getAnalysis(repositoryId: string): RepositoryAnalysis | undefined {
    const state = this.getState(repositoryId);
    return state?.analysis_json ? JSON.parse(state.analysis_json) as RepositoryAnalysis : undefined;
  }

  getSettings<T extends Record<string, unknown>>(repositoryId: string): T | undefined {
    const state = this.getState(repositoryId);
    return state?.settings_json ? JSON.parse(state.settings_json) as T : undefined;
  }

  saveSettings(repositoryId: string, settings: Record<string, unknown>): void {
    this.upsert(repositoryId, { settings: JSON.stringify(settings) });
  }

  /**
    文件摘要记录（L1）。

    沿用 `summaries` 表与 `summary` 列，只是列内容自 2026-09-18 起是 **JSON**（摘要 + 角色 + 覆盖率）——
    列本身是不透明 TEXT，不值得为改内容做一次表结构迁移。
    旧行是纯文本摘要，且缓存键口径已变（现在含切片与输入口径版本），本来不会再被命中：
    **读不出来就当未命中重算**，不猜、不补默认值。
  */
  getFileSummary<T extends { path: string; summary: string }>(cacheKey: string): T | undefined {
    const row = this.db.prepare("SELECT summary FROM summaries WHERE cache_key = ?").get(cacheKey) as { summary: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.summary) as T;
      return parsed && typeof parsed === "object" && typeof parsed.path === "string" && typeof parsed.summary === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  putFileSummary(cacheKey: string, value: { path: string; summary: string }): void {
    this.db.prepare("INSERT OR REPLACE INTO summaries(cache_key, summary, created_at) VALUES (?, ?, ?)")
      .run(cacheKey, JSON.stringify(value), new Date().toISOString());
  }

  /**
    每个文件**最新**的一条摘要（同一文件会有多行：缓存键里含切片与模型版本）。

    按写入时间倒序扫一遍、按路径取首次出现即可，不必让调用方理解缓存键的构造。
    带 `limit` 是因为这张表只会追加、长期累积后全表扫描会变慢；取不到的行不影响正确性
    （缺摘要 = 该文件没有已确认的职责，调用方按「未知」处理）。
  */
  getLatestFileSummaries(limit = 2_000): { path: string; summary: string; role?: string; coverageLow?: boolean }[] {
    const rows = this.db.prepare("SELECT summary FROM summaries ORDER BY created_at DESC LIMIT ?").all(limit) as { summary: string }[];
    const latest = new Map<string, { path: string; summary: string; role?: string; coverageLow?: boolean }>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.summary) as { path?: unknown; summary?: unknown; role?: unknown; coverage?: { low?: unknown } };
        if (typeof parsed.path !== "string" || typeof parsed.summary !== "string" || latest.has(parsed.path)) continue;
        latest.set(parsed.path, {
          path: parsed.path,
          summary: parsed.summary,
          ...(typeof parsed.role === "string" ? { role: parsed.role } : {}),
          ...(typeof parsed.coverage?.low === "boolean" ? { coverageLow: parsed.coverage.low } : {})
        });
      } catch {
        // 旧行是纯文本、或半截 JSON：跳过，不猜内容
      }
    }
    return [...latest.values()];
  }

  getExerciseCache<T>(repositoryId: string, contentVersion: string, kind: string, targetUnitId: string): T | undefined {
    const row = this.db.prepare("SELECT exercise_json FROM exercise_cache WHERE repository_id = ? AND content_version = ? AND kind = ? AND target_unit_id = ?")
      .get(repositoryId, contentVersion, kind, targetUnitId) as { exercise_json: string } | undefined;
    return row ? JSON.parse(row.exercise_json) as T : undefined;
  }

  getExerciseCacheById<T>(repositoryId: string, exerciseId: string): T | undefined {
    const row = this.db.prepare("SELECT exercise_json FROM exercise_cache WHERE repository_id = ? AND json_extract(exercise_json, '$.exercise.id') = ? ORDER BY created_at DESC LIMIT 1")
      .get(repositoryId, exerciseId) as { exercise_json: string } | undefined;
    return row ? JSON.parse(row.exercise_json) as T : undefined;
  }

  putExerciseCache(repositoryId: string, contentVersion: string, kind: string, targetUnitId: string, exercise: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO exercise_cache(repository_id, content_version, kind, target_unit_id, exercise_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(repositoryId, contentVersion, kind, targetUnitId, JSON.stringify(exercise), new Date().toISOString());
  }

  /**
    通用 L2 产物缓存（流程 / 推荐入口等），键由 `layerCacheKey()` 构造——键里已含仓库、口径版本、
    模型版本与本层输入哈希，所以读出来直接用，不需要任何失效判断。

    `at` 是毫秒时间戳，语义是「最后一次被用到」：TTL 按闲置时长算，命中方应回写续期（`touchLayerCache`）。
    每仓一个 DB 文件，所以这张表天然只装本仓的条目，不涉及跨仓清理；
    旧键（输入变了）永远不会再被命中，靠 `putLayerCache` 顺手按龄修剪兜底，防止无限累积。
  */
  getLayerCache<T>(key: string): { value: T; at: number } | undefined {
    const row = this.db.prepare("SELECT payload, at FROM layer_cache WHERE cache_key = ?").get(key) as { payload: string; at: number } | undefined;
    if (!row) return undefined;
    try {
      return { value: JSON.parse(row.payload) as T, at: row.at };
    } catch {
      return undefined;
    }
  }

  putLayerCache(key: string, value: unknown): void {
    const now = Date.now();
    this.db.prepare("INSERT OR REPLACE INTO layer_cache(cache_key, payload, at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), now);
    this.db.prepare("DELETE FROM layer_cache WHERE at < ?").run(now - LAYER_CACHE_MAX_AGE_MS);
  }

  touchLayerCache(key: string, at = Date.now()): void {
    this.db.prepare("UPDATE layer_cache SET at = ? WHERE cache_key = ?").run(at, key);
  }

  getMastery(repositoryId: string): MasteryRecord[] {
    const rows = this.db.prepare("SELECT mastery_json FROM learner_mastery WHERE repository_id = ? ORDER BY unit_id").all(repositoryId) as { mastery_json: string }[];
    return rows.map((row) => JSON.parse(row.mastery_json) as MasteryRecord);
  }

  saveMastery(repositoryId: string, record: MasteryRecord): void {
    this.db.prepare("INSERT OR REPLACE INTO learner_mastery(repository_id, unit_id, mastery_json, updated_at) VALUES (?, ?, ?, ?)")
      .run(repositoryId, record.unitId, JSON.stringify(record), new Date().toISOString());
  }

  getReviewSchedule(repositoryId: string, exerciseId: string): ReviewSchedule | undefined {
    const row = this.db.prepare("SELECT schedule_json FROM review_schedule WHERE repository_id = ? AND exercise_id = ?").get(repositoryId, exerciseId) as { schedule_json: string } | undefined;
    return row ? JSON.parse(row.schedule_json) as ReviewSchedule : undefined;
  }

  getReviewSchedules(repositoryId: string): ReviewSchedule[] {
    const rows = this.db.prepare("SELECT schedule_json FROM review_schedule WHERE repository_id = ?").all(repositoryId) as { schedule_json: string }[];
    return rows.map((row) => JSON.parse(row.schedule_json) as ReviewSchedule);
  }

  saveReviewSchedule(repositoryId: string, schedule: ReviewSchedule): void {
    this.db.prepare("INSERT OR REPLACE INTO review_schedule(repository_id, exercise_id, unit_id, schedule_json, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(repositoryId, schedule.exerciseId, schedule.unitId, JSON.stringify(schedule), new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  private getState(repositoryId: string): { index_json: string | null; course_json: string | null; estimate_json: string | null; analysis_json: string | null; settings_json: string | null } | undefined {
    return this.db.prepare("SELECT index_json, course_json, estimate_json, analysis_json, settings_json FROM repository_state WHERE repository_id = ?").get(repositoryId) as { index_json: string | null; course_json: string | null; estimate_json: string | null; analysis_json: string | null; settings_json: string | null } | undefined;
  }

  private upsert(repositoryId: string, patch: { index?: string; course?: string; estimate?: string; analysis?: string; settings?: string }): void {
    const existing = this.getState(repositoryId);
    this.db.prepare(`INSERT OR REPLACE INTO repository_state(repository_id, updated_at, index_json, course_json, estimate_json, analysis_json, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(repositoryId, new Date().toISOString(), patch.index ?? existing?.index_json ?? null, patch.course ?? existing?.course_json ?? null, patch.estimate ?? existing?.estimate_json ?? null, patch.analysis ?? existing?.analysis_json ?? null, patch.settings ?? existing?.settings_json ?? null);
  }
}
