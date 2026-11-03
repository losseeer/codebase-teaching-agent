import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AttemptKind, Contribution, RepositoryMeta, Topic } from "@codebase-tutor/domain";
import { LEARNER_MODEL_VERSION } from "@codebase-tutor/domain";
import { hash, tutorDataDir } from "@codebase-tutor/platform";

import { loadAddon } from "./betterSqlite3Loader.cjs";

/** 全局学习库路径：`~/.codebase-tutor/learner.db`；测试可用 `TUTOR_LEARNER_DB` 指向临时文件。 */
export function defaultLearnerDbPath(): string {
  return process.env.TUTOR_LEARNER_DB ?? join(tutorDataDir(), "learner.db");
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS topic (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  merged_into TEXT
);
CREATE TABLE IF NOT EXISTS contribution (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  topic_id TEXT,
  exercise_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  grading_mode TEXT NOT NULL,
  attempt_kind TEXT NOT NULL,
  score REAL NOT NULL,
  passed INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contribution_repository ON contribution(repository_id);
CREATE INDEX IF NOT EXISTS contribution_topic ON contribution(topic_id);
CREATE TABLE IF NOT EXISTS repository_meta (
  repository_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  stack_json TEXT NOT NULL DEFAULT '[]',
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface TopicRow {
  id: string;
  label: string;
  hint: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  merged_into: string | null;
}

interface ContributionRow {
  id: string;
  repository_id: string;
  topic_id: string | null;
  exercise_id: string;
  unit_id: string;
  kind: string;
  grading_mode: string;
  attempt_kind: string;
  score: number;
  passed: number;
  at: string;
}

interface RepositoryMetaRow {
  repository_id: string;
  label: string;
  stack_json: string;
  last_seen_at: string;
}

function topicOf(row: TopicRow): Topic {
  return { id: row.id, label: row.label, hint: row.hint, createdAt: row.created_at, updatedAt: row.updated_at };
}

function contributionOf(row: ContributionRow): Contribution {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    ...(row.topic_id ? { topicId: row.topic_id } : {}),
    exerciseId: row.exercise_id,
    unitId: row.unit_id,
    kind: row.kind,
    gradingMode: row.grading_mode,
    attemptKind: row.attempt_kind as AttemptKind,
    score: row.score,
    passed: row.passed === 1,
    at: row.at
  };
}

function repositoryMetaOf(row: RepositoryMetaRow): RepositoryMeta {
  let stacks: string[] = [];
  try {
    const parsed = JSON.parse(row.stack_json) as unknown;
    stacks = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    // 坏 JSON 按空栈处理，不阻止画像读取
  }
  return { repositoryId: row.repository_id, label: row.label, stacks, lastSeenAt: row.last_seen_at };
}

/** 用户级学习库：主题、跨仓原始证据、仓库元信息与公式版本；一行一事实，不存计数器。 */
export class LearnerStore {
  private readonly db: Database.Database;

  constructor(readonly path = defaultLearnerDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    const nativeBinding = loadAddon() as unknown as string;
    this.db = new Database(path, { nativeBinding });
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
    // 掌握度每次从 journal 回放，公式升级不需要迁移数据；这里只标记当前公式版本。
    this.setMeta("model_version", LEARNER_MODEL_VERSION);
  }

  close(): void {
    this.db.close();
  }

  get modelVersion(): string {
    return this.getMeta("model_version") ?? LEARNER_MODEL_VERSION;
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
  }

  /** 活跃主题：未软删、未合并的才出现在选择器里。 */
  listTopics(): Topic[] {
    const rows = this.db.prepare("SELECT * FROM topic WHERE deleted_at IS NULL AND merged_into IS NULL ORDER BY created_at ASC").all() as TopicRow[];
    return rows.map(topicOf);
  }

  /** 按 id 取主题；默认只认活跃主题，`includeInactive` 用于合并/删除的幂等处理。 */
  getTopic(topicId: string, includeInactive = false): Topic | undefined {
    const row = this.db.prepare("SELECT * FROM topic WHERE id = ?").get(topicId) as TopicRow | undefined;
    if (!row) return undefined;
    if (!includeInactive && (row.deleted_at || row.merged_into)) return undefined;
    return topicOf(row);
  }

  /** 跟随 `merged_into` 解析最终主题；被软删或链断了返回 undefined。 */
  resolveTopic(topicId: string): Topic | undefined {
    let current = this.getTopic(topicId, true);
    const seen = new Set<string>();
    while (current && current.id && !seen.has(current.id)) {
      seen.add(current.id);
      const row = this.db.prepare("SELECT * FROM topic WHERE id = ?").get(current.id) as TopicRow | undefined;
      if (!row || row.deleted_at) return undefined;
      if (!row.merged_into) return current;
      current = this.getTopic(row.merged_into, true);
    }
    return undefined;
  }

  /** 新建主题；带相同 id 时更新并恢复（GUI 本地主题迁移可重复执行）。 */
  createTopic(input: { id?: string; label: string; hint?: string }): Topic {
    const label = input.label.trim() || "未命名主题";
    const topicId = input.id?.trim() || `custom-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO topic(id, label, hint, created_at, updated_at, deleted_at, merged_into)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, hint = excluded.hint, updated_at = excluded.updated_at, deleted_at = NULL, merged_into = NULL
    `).run(topicId, label, input.hint ?? "", now, now);
    return this.getTopic(topicId)!;
  }

  updateTopic(topicId: string, patch: { label?: string; hint?: string }): Topic | undefined {
    const current = this.getTopic(topicId);
    if (!current) return undefined;
    const label = patch.label?.trim() || current.label;
    const hint = patch.hint ?? current.hint;
    this.db.prepare("UPDATE topic SET label = ?, hint = ?, updated_at = ? WHERE id = ?").run(label, hint, new Date().toISOString(), topicId);
    return this.getTopic(topicId);
  }

  /** 软删：主题从列表消失，原始 contribution 保留。 */
  softDeleteTopic(topicId: string): boolean {
    return this.db.prepare("UPDATE topic SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(new Date().toISOString(), new Date().toISOString(), topicId).changes > 0;
  }

  /** 合并：contribution 迁到目标主题，源主题写 `merged_into`。 */
  mergeTopics(sourceId: string, targetId: string): Topic | undefined {
    if (sourceId === targetId) return this.getTopic(targetId);
    const source = this.getTopic(sourceId);
    const target = this.getTopic(targetId);
    if (!source || !target) return undefined;
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      this.db.prepare("UPDATE contribution SET topic_id = ? WHERE topic_id = ?").run(targetId, sourceId);
      this.db.prepare("UPDATE topic SET merged_into = ?, updated_at = ? WHERE id = ?").run(targetId, now, sourceId);
    });
    run();
    return this.getTopic(targetId);
  }

  /**
    一行一次 exercise_result。id 由（仓, 题, 单元, 时间, 作答类型）算成确定性值，
    旧 journal 回放与新作答写同一行时 `INSERT OR IGNORE` 不会重复。
  */
  appendContribution(input: Omit<Contribution, "id"> & { id?: string }): Contribution {
    const row: Contribution = {
      id: input.id ?? `contribution:${hash(`${input.repositoryId}:${input.exerciseId}:${input.unitId}:${input.at}:${input.attemptKind}`).slice(0, 24)}`,
      repositoryId: input.repositoryId,
      ...(input.topicId ? { topicId: input.topicId } : {}),
      exerciseId: input.exerciseId,
      unitId: input.unitId,
      kind: input.kind,
      gradingMode: input.gradingMode,
      attemptKind: input.attemptKind,
      score: input.score,
      passed: input.passed,
      at: input.at
    };
    this.db.prepare(`
      INSERT OR IGNORE INTO contribution(id, repository_id, topic_id, exercise_id, unit_id, kind, grading_mode, attempt_kind, score, passed, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.repositoryId, row.topicId ?? null, row.exerciseId, row.unitId, row.kind, row.gradingMode, row.attemptKind, row.score, row.passed ? 1 : 0, row.at);
    return row;
  }

  listContributions(filter: { repositoryId?: string; topicId?: string } = {}): Contribution[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.repositoryId) { clauses.push("repository_id = ?"); values.push(filter.repositoryId); }
    if (filter.topicId) { clauses.push("topic_id = ?"); values.push(filter.topicId); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM contribution ${where} ORDER BY at ASC`).all(...values) as ContributionRow[];
    return rows.map(contributionOf);
  }

  /** 「遗忘此仓」：原始贡献与仓库元信息一起删；journal 与仓内产物不动。 */
  forgetRepository(repositoryId: string): { contributions: number } {
    const run = this.db.transaction(() => {
      const changed = this.db.prepare("DELETE FROM contribution WHERE repository_id = ?").run(repositoryId).changes;
      this.db.prepare("DELETE FROM repository_meta WHERE repository_id = ?").run(repositoryId);
      return changed;
    });
    return { contributions: run() };
  }

  touchRepository(input: Omit<RepositoryMeta, "lastSeenAt">): RepositoryMeta {
    const lastSeenAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO repository_meta(repository_id, label, stack_json, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET label = excluded.label, stack_json = excluded.stack_json, last_seen_at = excluded.last_seen_at
    `).run(input.repositoryId, input.label, JSON.stringify(input.stacks), lastSeenAt);
    return { ...input, lastSeenAt };
  }

  listRepositoryMeta(): RepositoryMeta[] {
    const rows = this.db.prepare("SELECT * FROM repository_meta ORDER BY last_seen_at DESC").all() as RepositoryMetaRow[];
    return rows.map(repositoryMetaOf);
  }
}
