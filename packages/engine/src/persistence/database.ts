import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ImportEstimate, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";
import { ChatRepository } from "./chat-repository.js";
import { CheckpointRepository } from "./checkpoint-repository.js";
import { ExerciseRepository } from "./exercise-repository.js";
import { FactRepository } from "./fact-repository.js";
import { ReviewRepository } from "./review-repository.js";
import { SummaryRepository } from "./summary-repository.js";

import { loadAddon } from "./betterSqlite3Loader.cjs";
import { DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { declaredColumns } from "./declared-columns.js";

const schemaVersion = 8;

// 预加载对应当前 Node ABI 的 native binding，避免默认解析路径触发 ABI mismatch。
// runtime 接受 addon 对象而 @types 只声明 string，故 cast。
const nativeBinding = loadAddon() as unknown as string;
/**
  唯一的一处「开连接 → 用 → 关」。写在 try/finally：这些调用挂在每个对话回合的读写路径上，
  尾置的 close() 一被异常跳过就攒文件描述符，攒够把进程拖到 EMFILE。
  */
export function withDatabase<T>(repositoryPath: string, run: (database: TutorDatabase) => T): T {
  const database = new TutorDatabase(repositoryPath);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

/** 声明里的约束列：ADD COLUMN 加不出这些，缺了必须写真迁移（带回填的那种）。 */
const NOT_ADDABLE = /\b(PRIMARY|UNIQUE|REFERENCES|CHECK)\b/i;

export class TutorDatabase {
  private readonly db: Database.Database;
  /** 一道题的题行与它的复习排期：各是一张表的唯一读写口（`persistence/exercise-repository.ts` / `review-repository.ts`）。 */
  readonly exercises: ExerciseRepository;
  readonly reviews: ReviewRepository;
  readonly checkpoints: CheckpointRepository;
  readonly chats: ChatRepository;
  /** L1 摘要与四类文件级静态产物：各自一张表的唯一读写口。 */
  readonly summaries: SummaryRepository;
  readonly facts: FactRepository;
  /** 开库所在的路径（只为把告警说成「哪个仓的库」，不参与任何判据）。 */
  readonly repositoryPathLabel: string;
  /**
    对账没能补上的列（`表.列`）。空数组 = 这份库的形状等于声明。
    交出来而不是抛，是不把用户的存量库变成打不开的东西；挂载时这条读数会进 `engine.jsonl`。
    */
  readonly schemaGaps: string[] = [];

  constructor(readonly repositoryPath: string) {
    const tutorDir = join(repositoryPath, ".tutor");
    if (!existsSync(tutorDir)) mkdirSync(tutorDir, { recursive: true });
    this.repositoryPathLabel = repositoryPath;
    this.db = new Database(join(tutorDir, "tutor.db"), { nativeBinding });
    this.db.pragma("journal_mode = WAL");
    // 只能在 `db` 装上之后建：早一行交出去的就是 undefined
    this.exercises = new ExerciseRepository(this.db);
    this.reviews = new ReviewRepository(this.db);
    this.checkpoints = new CheckpointRepository(this.db);
    this.chats = new ChatRepository(this.db);
    this.summaries = new SummaryRepository(this.db);
    this.facts = new FactRepository(this.db);
    try {
      this.migrate();
    } catch (error) {
      // 迁移失败时实例还没交出去，调用方无从 close：schema 版本过高或 ALTER 撞车时每试一次就漏一对 WAL 描述符，攒到 EMFILE
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
      // 与 v<7 同一判据：走过 CREATE 或上次只跑了一条 ALTER 的库已带这两列，无守卫的 ADD COLUMN 会抛 duplicate column，之后每次开库都失败
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
      // 走过上面 CREATE 的库已带这一列，无守卫的 ALTER 会抛 duplicate column
      const hasState = (this.db.prepare("PRAGMA table_info(chat_session)").all() as { name: string }[]).some((column) => column.name === "state_json");
      if (!hasState) this.db.exec("ALTER TABLE chat_session ADD COLUMN state_json TEXT;");
      this.db.prepare("UPDATE schema_version SET version = ?").run(schemaVersion);
    }
    if (current.version < 8) this.db.prepare("UPDATE schema_version SET version = ?").run(8);
    // 列对账必须放在版本梯子之后，否则梯子里的 ALTER 会撞 duplicate column
    this.reconcileColumns(schema);
    if (current.version > schemaVersion) {
      throw new Error(`Unsupported .tutor schema version ${current.version}`);
    }
  }

  /**
    列对账：以声明文本为唯一源，把「声明里有、表里还没有」的列补上；幂等，不依赖版本号是否翻对。
    补不上的（带约束、或 NOT NULL 又没默认值）记进 schemaGaps 并告警，不抛：
    崩在开库上等于锁死用户已有的学习记录，留给读取点失败才能带上具体列名。
    */
  private reconcileColumns(schema: string): void {
    for (const declared of declaredColumns(schema)) {
      const present = (this.db.prepare(`PRAGMA table_info(${declared.table})`).all() as { name: string }[]).some((column) => column.name === declared.column);
      if (present) continue;
      if (NOT_ADDABLE.test(declared.declaration) || (/\bNOT NULL\b/i.test(declared.declaration) && !/\bDEFAULT\b/i.test(declared.declaration))) {
        const gap = `${declared.table}.${declared.column}`;
        this.schemaGaps.push(gap);
        console.warn(`[engine] ${this.repositoryPathLabel ?? "产物库"} 缺列 ${gap}，而它的声明是「${declared.declaration}」：ADD COLUMN 加不出这种列，需要写一条一次性迁移（建新表、回填、换名）。`);
        continue;
      }
      this.db.exec(`ALTER TABLE ${declared.table} ADD COLUMN ${declared.declaration.replace(/\s+/g, " ").trim()}`);
    }
  }

  saveIndex(index: RepositoryIndex): void {
    this.upsert(index.repositoryId, { index: JSON.stringify(index) });
  }

  saveEstimate(repositoryId: string, estimate: ImportEstimate): void {
    this.upsert(repositoryId, { estimate: JSON.stringify(estimate) });
  }

  saveAnalysis(analysis: RepositoryAnalysis): void {
    this.upsert(analysis.repositoryId, { analysis: JSON.stringify(analysis) });
  }

  getIndex(repositoryId: string): RepositoryIndex | undefined {
    const value = this.getJsonColumn(repositoryId, "index_json");
    return value ? JSON.parse(value) as RepositoryIndex : undefined;
  }

  getEstimate(repositoryId: string): ImportEstimate | undefined {
    const value = this.getJsonColumn(repositoryId, "estimate_json");
    return value ? JSON.parse(value) as ImportEstimate : undefined;
  }

  getAnalysis(repositoryId: string): RepositoryAnalysis | undefined {
    const value = this.getJsonColumn(repositoryId, "analysis_json");
    return value ? JSON.parse(value) as RepositoryAnalysis : undefined;
  }

  getSettings<T extends Record<string, unknown>>(repositoryId: string): T | undefined {
    const value = this.getJsonColumn(repositoryId, "settings_json");
    return value ? JSON.parse(value) as T : undefined;
  }

  saveSettings(repositoryId: string, settings: Record<string, unknown>): void {
    this.upsert(repositoryId, { settings: JSON.stringify(settings) });
  }

  /**
    画布上的一张图（persistence/diagrams.ts 是唯一业务读写口，这里只收 SQL）。
    列一律 AS 成返回类型上的驼峰名：better-sqlite3 按 SQL 里写的列名交回键，
    类型是断言出来的、编译器不报，键名不一致到运行期才炸。
  */
  listDiagramRows(repositoryId: string): { diagramId: string; name: string; source: string; createdAt: number; updatedAt: number; payload: string }[] {
    return this.db.prepare("SELECT diagram_id AS diagramId, name, source, created_at AS createdAt, updated_at AS updatedAt, payload FROM diagram WHERE repository_id = ? ORDER BY updated_at DESC").all(repositoryId) as
      { diagramId: string; name: string; source: string; createdAt: number; updatedAt: number; payload: string }[];
  }

  getDiagramRow(repositoryId: string, diagramId: string): { name: string; source: string; createdAt: number; updatedAt: number; payload: string } | undefined {
    return this.db.prepare("SELECT name, source, created_at AS createdAt, updated_at AS updatedAt, payload FROM diagram WHERE repository_id = ? AND diagram_id = ?").get(repositoryId, diagramId) as
      | { name: string; source: string; createdAt: number; updatedAt: number; payload: string } | undefined;
  }

  putDiagramRow(repositoryId: string, diagramId: string, row: { name: string; source: string; createdAt: number; updatedAt: number; payload: unknown }): void {
    this.db.prepare("INSERT OR REPLACE INTO diagram(repository_id, diagram_id, name, source, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(repositoryId, diagramId, row.name, row.source, row.createdAt, row.updatedAt, JSON.stringify(row.payload));
  }

  deleteDiagramRow(repositoryId: string, diagramId: string): void {
    this.db.prepare("DELETE FROM diagram WHERE repository_id = ? AND diagram_id = ?").run(repositoryId, diagramId);
  }

  close(): void {
    this.db.close();
  }

  /**
    一次只取要的那一列：analysis_json 是大仓里最重的一块，整行捞取会让轻读付重代价。
    列名取自这张表固定的四个，不接受外部字符串，拼进 SQL 不构成注入面。
    */
  private getJsonColumn(repositoryId: string, column: "index_json" | "estimate_json" | "analysis_json" | "settings_json"): string | null | undefined {
    const row = this.db.prepare(`SELECT ${column} AS value FROM repository_state WHERE repository_id = ?`).get(repositoryId) as { value: string | null } | undefined;
    return row?.value;
  }

  /**
    只写这次给出来的那几列：ON CONFLICT DO UPDATE 只碰给了值的列，其余留在原地不动。
    列名从这张表固定的四个键里查，外部字符串进不了 SQL。
    */
  private upsert(repositoryId: string, patch: { index?: string; estimate?: string; analysis?: string; settings?: string }): void {
    const columnOf = { index: "index_json", estimate: "estimate_json", analysis: "analysis_json", settings: "settings_json" } as const;
    const keys = (Object.keys(columnOf) as (keyof typeof columnOf)[]).filter((key) => patch[key] !== undefined);
    if (!keys.length) return;
    const columns = keys.map((key) => columnOf[key]).join(", ");
    const assignments = keys.map((key) => `${columnOf[key]} = excluded.${columnOf[key]}`).join(", ");
    this.db.prepare(`INSERT INTO repository_state(repository_id, updated_at, ${columns})
      VALUES (?, ?, ${keys.map(() => "?").join(", ")})
      ON CONFLICT(repository_id) DO UPDATE SET updated_at = excluded.updated_at, ${assignments}`)
      .run(repositoryId, new Date().toISOString(), ...keys.map((key) => patch[key]));
  }
}

