import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAddon } from "./betterSqlite3Loader.cjs";
import { DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { TutorDatabase } from "./database.js";
import { declaredColumns } from "./declared-columns.js";

/** 形状迁移守卫：声明里加一列要落到存量库，删一列也要从存量库真删。 */
describe("产物库形状对账", () => {
  let repository: string;
  const dbFile = (): string => join(repository, ".tutor", "tutor.db");

  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-db-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  /** 用原始连接执行一条 SQL，用完即关。 */
  const surgery = (sql: string): void => {
    const raw = new Database(dbFile(), { nativeBinding: loadAddon() as unknown as string });
    try {
      raw.exec(sql);
    } finally {
      raw.close();
    }
  };
  const columnsOf = (table: string): string[] => {
    const raw = new Database(dbFile(), { nativeBinding: loadAddon() as unknown as string });
    try {
      return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
    } finally {
      raw.close();
    }
  };

  it("新库逐列等于声明（声明与实库之间不许有漂移）", () => {
    const database = new TutorDatabase(repository);
    database.close();
    const missing = declaredColumns(DATABASE_SCHEMA_SQL).filter((declared) => !columnsOf(declared.table).includes(declared.column));
    expect(missing.map((declared) => `${declared.table}.${declared.column}`)).toEqual([]);
  });

  it("存量库少一个可加的列：重开一次就补回来", () => {
    new TutorDatabase(repository).close();
    expect(columnsOf("chat_message")).toContain("error");
    surgery("ALTER TABLE chat_message DROP COLUMN error;");
    expect(columnsOf("chat_message")).not.toContain("error");
    new TutorDatabase(repository).close();
    expect(columnsOf("chat_message")).toContain("error");
  });

  it("缺的是加不出的列（NOT NULL 没默认值）：不崩开库，但把缺口交出来", () => {
    new TutorDatabase(repository).close();
    surgery("ALTER TABLE chat_session DROP COLUMN title;");
    /** 开库不抛：缺口作为 `schemaGaps` 读数交出。 */
    const database = new TutorDatabase(repository);
    expect(database.schemaGaps).toContain("chat_session.title");
    database.close();
  });

  it("对账跑在梯子之后：老库（version=1）开一次不撞 duplicate column，两列都补齐", () => {
    // 手工造一份还没有 analysis_json / settings_json 的老库
    mkdirSync(join(repository, ".tutor"), { recursive: true });
    surgery(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES (1);
      CREATE TABLE repository_state (repository_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, index_json TEXT, course_json TEXT, estimate_json TEXT);
    `);
    const database = new TutorDatabase(repository);
    database.close();
    const columns = columnsOf("repository_state");
    expect(columns).toEqual(expect.arrayContaining(["analysis_json", "settings_json"]));
    expect(columns.filter((name) => name === "analysis_json")).toHaveLength(1);
  });

  it("反复打开是幂等的（对账不会第二次再补一遍）", () => {
    new TutorDatabase(repository).close();
    surgery("ALTER TABLE chat_message DROP COLUMN error;");
    new TutorDatabase(repository).close();
    new TutorDatabase(repository).close();
    expect(columnsOf("chat_message")).toContain("error");
  });

  it("老库（version=8）开一次：退役表、退役列与退役题型的行都消失", () => {
    new TutorDatabase(repository).close();
    surgery(`
      CREATE TABLE layer_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE diagram_artifact (repository_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, purpose TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE learner_mastery (repository_id TEXT NOT NULL, unit_id TEXT NOT NULL, mastery_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE search_vector (repository_id TEXT NOT NULL, unit_id TEXT NOT NULL, tokens TEXT NOT NULL);
      CREATE TABLE companion_suggestions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO layer_cache VALUES ('k', '{}', 1);
      ALTER TABLE repository_state ADD COLUMN course_json TEXT;
      ALTER TABLE chat_session ADD COLUMN course_node_id TEXT;
      ALTER TABLE chat_message ADD COLUMN stage TEXT;
      INSERT INTO exercise_cache(repository_id, content_version, kind, target_unit_id, exercise_json, created_at)
        VALUES ('repo', 'v1', 'output_prediction', 'unit', '{"exercise":{"id":"e-old","kind":"output_prediction"}}', '2026-01-01');
      INSERT INTO review_schedule(repository_id, exercise_id, unit_id, schedule_json, updated_at) VALUES ('repo', 'e-old', 'unit', '{}', '2026-01-01');
      UPDATE schema_version SET version = 8;
    `);
    const database = new TutorDatabase(repository);
    database.close();
    const raw = new Database(dbFile(), { nativeBinding: loadAddon() as unknown as string });
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name);
    const exerciseRows = raw.prepare("SELECT count(*) c FROM exercise_cache").get() as { c: number };
    const reviewRows = raw.prepare("SELECT count(*) c FROM review_schedule").get() as { c: number };
    const version = (raw.prepare("SELECT version FROM schema_version").get() as { version: number }).version;
    raw.close();
    expect(tables.filter((name) => ["layer_cache", "diagram_artifact", "learner_mastery", "search_vector", "companion_suggestions"].includes(name))).toEqual([]);
    expect(columnsOf("repository_state")).not.toContain("course_json");
    expect(columnsOf("chat_session")).not.toContain("course_node_id");
    expect(columnsOf("chat_message")).not.toContain("stage");
    expect(exerciseRows.c).toBe(0);
    expect(reviewRows.c).toBe(0);
    expect(version).toBe(9);
  });
});
