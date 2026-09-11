import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CompanionSuggestion, CourseTree, ImportEstimate, MasteryRecord, RepositoryAnalysis, RepositoryIndex, ReviewSchedule } from "@codebase-tutor/shared";

const schemaVersion = 4;

export class TutorDatabase {
  private readonly db: Database.Database;

  constructor(readonly repositoryPath: string) {
    const tutorDir = join(repositoryPath, ".tutor");
    if (!existsSync(tutorDir)) mkdirSync(tutorDir, { recursive: true });
    this.db = new Database(join(tutorDir, "tutor.db"));
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
      CREATE TABLE IF NOT EXISTS companion_suggestions (
        repository_id TEXT NOT NULL,
        suggestion_id TEXT NOT NULL,
        status TEXT NOT NULL,
        suggestion_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(repository_id, suggestion_id)
      );
      CREATE INDEX IF NOT EXISTS companion_suggestions_status ON companion_suggestions(repository_id, status, created_at DESC);
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
    if (current.version < 4) this.db.prepare("UPDATE schema_version SET version = ?").run(schemaVersion);
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

  getSummary(cacheKey: string): string | undefined {
    const row = this.db.prepare("SELECT summary FROM summaries WHERE cache_key = ?").get(cacheKey) as { summary: string } | undefined;
    return row?.summary;
  }

  putSummary(cacheKey: string, summary: string): void {
    this.db.prepare("INSERT OR REPLACE INTO summaries(cache_key, summary, created_at) VALUES (?, ?, ?)")
      .run(cacheKey, summary, new Date().toISOString());
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

  getCompanionSuggestion(repositoryId: string, suggestionId: string): CompanionSuggestion | undefined {
    const row = this.db.prepare("SELECT suggestion_json FROM companion_suggestions WHERE repository_id = ? AND suggestion_id = ?")
      .get(repositoryId, suggestionId) as { suggestion_json: string } | undefined;
    return row ? JSON.parse(row.suggestion_json) as CompanionSuggestion : undefined;
  }

  getCompanionSuggestions(repositoryId: string, statuses: CompanionSuggestion["status"][] = ["pending"]): CompanionSuggestion[] {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT suggestion_json FROM companion_suggestions WHERE repository_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC`).all(repositoryId, ...statuses) as { suggestion_json: string }[];
    return rows.map((row) => JSON.parse(row.suggestion_json) as CompanionSuggestion);
  }

  saveCompanionSuggestion(repositoryId: string, suggestion: CompanionSuggestion): void {
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR REPLACE INTO companion_suggestions(repository_id, suggestion_id, status, suggestion_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(repositoryId, suggestion.id, suggestion.status, JSON.stringify(suggestion), suggestion.createdAt, now);
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
