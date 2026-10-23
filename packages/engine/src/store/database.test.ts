import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAddon } from "./betterSqlite3Loader.cjs";
import { DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { TutorDatabase } from "./database.js";
import { declaredColumns } from "./declared-columns.js";

/**
  形状迁移的守卫：CREATE TABLE IF NOT EXISTS 对已存在的表一个列都不加。
  reconcileColumns 每次开机逐列对账，这组用例钉住对账行为——往声明里加一列，存量库也要落地，不能只有新仓有。
  */
describe("产物库形状对账", () => {
  let repository: string;
  const dbFile = (): string => join(repository, ".tutor", "tutor.db");

  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-db-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  /** 拿原始连接做一次破坏形状的手术（模拟用户手上那份老库），用完就关。 */
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
    // `stage` 是退役列（不再读写），拿它做手术最贴近「老库里就是没有这一格」
    expect(columnsOf("chat_message")).toContain("stage");
    surgery("ALTER TABLE chat_message DROP COLUMN stage;");
    expect(columnsOf("chat_message")).not.toContain("stage");
    new TutorDatabase(repository).close();
    expect(columnsOf("chat_message")).toContain("stage");
  });

  it("缺的是加不出的列（NOT NULL 没默认值）：不崩开库，但把缺口交出来", () => {
    new TutorDatabase(repository).close();
    surgery("ALTER TABLE chat_session DROP COLUMN title;");
    /**
      这条刻意不抛：抛在开库上等于把用户已有的学习记录变成打不开的库。
      缺口是读数（schemaGaps），挂载时进 engine.jsonl；那一列真被读到时，失败点带得出列名。
      */
    const database = new TutorDatabase(repository);
    expect(database.schemaGaps).toContain("chat_session.title");
    database.close();
  });

  it("对账跑在梯子之后：老库（version=1）开一次不撞 duplicate column，两列都补齐", () => {
    // 手工造一份还没有 analysis_json / settings_json 的库：梯子和对账都认识这两列，顺序错了就是 duplicate column 崩在开机上。
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
    surgery("ALTER TABLE chat_message DROP COLUMN stage;");
    new TutorDatabase(repository).close();
    new TutorDatabase(repository).close();
    expect(columnsOf("chat_message")).toContain("stage");
  });
});
