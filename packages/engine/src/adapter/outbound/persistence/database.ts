import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExerciseKind } from "@codebase-tutor/domain";
import { SUPPORTED_EXERCISE_KINDS } from "@codebase-tutor/domain";
import { ChatRepository } from "./chat-repository.js";
import { CheckpointRepository } from "./checkpoint-repository.js";
import { DiagramRepository } from "./diagram-repository.js";
import { ExerciseRepository } from "./exercise-repository.js";
import { FactRepository } from "./fact-repository.js";
import { ReviewRepository } from "./review-repository.js";
import { StateRepository } from "./state-repository.js";
import { SummaryRepository } from "./summary-repository.js";

import { loadAddon } from "./betterSqlite3Loader.cjs";
import { DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { declaredColumns } from "./declared-columns.js";

const schemaVersion = 9;

// runtime 接受 addon 对象，@types 只声明 string
const nativeBinding = loadAddon() as unknown as string;
/** 开连接、使用、关闭；异常路径也关闭。 */
export function withDatabase<T>(repositoryPath: string, run: (database: TutorDatabase) => T): T {
  const database = new TutorDatabase(repositoryPath);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

/** 带约束的列声明：ADD COLUMN 无法添加。 */
const NOT_ADDABLE = /\b(PRIMARY|UNIQUE|REFERENCES|CHECK)\b/i;

/** 产物库句柄：开库、迁移、列对账、关闭；每张表一个读写口。 */
export class TutorDatabase {
  private readonly db: Database.Database;
  /** 每张表各自的读写口。 */
  readonly state: StateRepository;
  readonly summaries: SummaryRepository;
  readonly facts: FactRepository;
  readonly exercises: ExerciseRepository;
  readonly reviews: ReviewRepository;
  readonly checkpoints: CheckpointRepository;
  readonly diagrams: DiagramRepository;
  readonly chats: ChatRepository;
  /** 告警文案里的仓库路径。 */
  readonly repositoryPathLabel: string;
  /** 列对账未补上的列，形如 `表.列`。 */
  readonly schemaGaps: string[] = [];

  constructor(readonly repositoryPath: string) {
    const tutorDir = join(repositoryPath, ".tutor");
    if (!existsSync(tutorDir)) mkdirSync(tutorDir, { recursive: true });
    this.repositoryPathLabel = repositoryPath;
    this.db = new Database(join(tutorDir, "tutor.db"), { nativeBinding });
    this.db.pragma("journal_mode = WAL");
    this.state = new StateRepository(this.db);
    this.summaries = new SummaryRepository(this.db);
    this.facts = new FactRepository(this.db);
    this.exercises = new ExerciseRepository(this.db);
    this.reviews = new ReviewRepository(this.db);
    this.checkpoints = new CheckpointRepository(this.db);
    this.diagrams = new DiagramRepository(this.db);
    this.chats = new ChatRepository(this.db);
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    const schema = DATABASE_SCHEMA_SQL;
    this.db.exec(schema);
    const current = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
    if (!current) {
      this.db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(schemaVersion);
      return;
    }
    if (current.version < 2) {
      const stateColumns = new Set((this.db.prepare("PRAGMA table_info(repository_state)").all() as { name: string }[]).map((column) => column.name));
      if (!stateColumns.has("analysis_json")) this.db.exec("ALTER TABLE repository_state ADD COLUMN analysis_json TEXT;");
      if (!stateColumns.has("settings_json")) this.db.exec("ALTER TABLE repository_state ADD COLUMN settings_json TEXT;");
      this.db.prepare("UPDATE schema_version SET version = ?").run(2);
    }
    if (current.version < 3) this.db.prepare("UPDATE schema_version SET version = ?").run(3);
    if (current.version < 4) this.db.prepare("UPDATE schema_version SET version = ?").run(4);
    if (current.version < 5) this.db.prepare("UPDATE schema_version SET version = ?").run(5);
    if (current.version < 6) this.db.prepare("UPDATE schema_version SET version = ?").run(6);
    if (current.version < 7) {
      const hasState = (this.db.prepare("PRAGMA table_info(chat_session)").all() as { name: string }[]).some((column) => column.name === "state_json");
      if (!hasState) this.db.exec("ALTER TABLE chat_session ADD COLUMN state_json TEXT;");
      this.db.prepare("UPDATE schema_version SET version = ?").run(schemaVersion);
    }
    if (current.version < 8) this.db.prepare("UPDATE schema_version SET version = ?").run(8);
    if (current.version < 9) {
      // 删除多余的表与列、不支持的题型缓存行、孤儿复排计划
      for (const table of ["layer_cache", "diagram_artifact", "companion_suggestions", "learner_mastery", "search_vector"]) this.db.exec(`DROP TABLE IF EXISTS ${table};`);
      for (const [table, column] of [["repository_state", "course_json"], ["chat_session", "course_node_id"], ["chat_message", "stage"]] as const) {
        const present = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((candidate) => candidate.name === column);
        if (present) this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column};`);
      }
      const retired = (this.db.prepare("SELECT DISTINCT kind FROM exercise_cache").all() as { kind: string }[]).filter((row) => !SUPPORTED_EXERCISE_KINDS.includes(row.kind as ExerciseKind));
      for (const row of retired) this.db.prepare("DELETE FROM exercise_cache WHERE kind = ?").run(row.kind);
      this.db.exec("DELETE FROM review_schedule WHERE exercise_id NOT IN (SELECT json_extract(exercise_json, '$.exercise.id') FROM exercise_cache);");
      this.db.prepare("UPDATE schema_version SET version = ?").run(9);
    }
    this.reconcileColumns(schema);
    if (current.version > schemaVersion) {
      throw new Error(`Unsupported .tutor schema version ${current.version}`);
    }
  }

  /** 列对账：声明里有、表里还没有的列补上；补不上的记进 schemaGaps 并告警。 */
  private reconcileColumns(schema: string): void {
    for (const declared of declaredColumns(schema)) {
      const present = (this.db.prepare(`PRAGMA table_info(${declared.table})`).all() as { name: string }[]).some((column) => column.name === declared.column);
      if (present) continue;
      if (NOT_ADDABLE.test(declared.declaration) || (/\bNOT NULL\b/i.test(declared.declaration) && !/\bDEFAULT\b/i.test(declared.declaration))) {
        const gap = `${declared.table}.${declared.column}`;
        this.schemaGaps.push(gap);
        console.warn(`[engine] ${this.repositoryPathLabel ?? "产物库"} 缺列 ${gap}（声明「${declared.declaration}」），需要一次性迁移补上。`);
        continue;
      }
      this.db.exec(`ALTER TABLE ${declared.table} ADD COLUMN ${declared.declaration.replace(/\s+/g, " ").trim()}`);
    }
  }

  close(): void {
    this.db.close();
  }
}

