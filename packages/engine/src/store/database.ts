import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FactKind, ImportEstimate, RepositoryAnalysis, RepositoryIndex, ReviewSchedule } from "@codebase-tutor/domain";

import { loadAddon } from "./betterSqlite3Loader.cjs";
import { DATABASE_SCHEMA_SQL } from "./database-schema.js";
import { declaredColumns } from "./declared-columns.js";

const schemaVersion = 8;

// 预加载对应当前 Node ABI 的 native binding，避免默认解析路径触发 ABI mismatch。
// runtime 接受 addon 对象而 @types 只声明 string，故 cast。
const nativeBinding = loadAddon() as unknown as string;

/** getLatestFileSummaries 的默认行数上限；同时导出给调用方做达到上限的判据，避免各处字面量分叉。 */
export const LATEST_SUMMARY_LIMIT = 2_000;

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

/** chat_session 的行形状（snake_case 贴着表；域类型转换在 store/chat-store.ts）。 */
export interface ChatSessionRow {
  id: string;
  repository_id: string;
  scope: string;
  /** 教学作用域：`file:<path>` / `dir:<path>`；旧行的 course_node_id 不再读取。 */
  scope_ref: string | null;
  exercise_id: string | null;
  title: string;
  state_json: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ChatMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  error: string | null;
}

/** 声明里的约束列：ADD COLUMN 加不出这些，缺了必须写真迁移（带回填的那种）。 */
const NOT_ADDABLE = /\b(PRIMARY|UNIQUE|REFERENCES|CHECK)\b/i;

export class TutorDatabase {
  private readonly db: Database.Database;
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
    写一批文件级静态产物。replaceAll 表示这批是该产物的全集（删掉已消失文件的行）；
    不传则只按文件增改，其余文件的产物保持有效。
  */
  saveFileFacts(repositoryId: string, kind: FactKind, rows: { path: string; payload: unknown }[], options?: { replaceAll?: boolean }): void {
    const insert = this.db.prepare("INSERT OR REPLACE INTO static_fact(repository_id, kind, path, payload, at) VALUES (?, ?, ?, ?, ?)");
    const at = Date.now();
    const tx = this.db.transaction((batch: { path: string; payload: unknown }[]) => {
      if (options?.replaceAll) this.db.prepare("DELETE FROM static_fact WHERE repository_id = ? AND kind = ?").run(repositoryId, kind);
      for (const row of batch) insert.run(repositoryId, kind, row.path, JSON.stringify(row.payload), at);
    });
    tx(rows);
  }

  getFileFact<T>(repositoryId: string, kind: FactKind, path: string): T | undefined {
    const row = this.db.prepare("SELECT payload FROM static_fact WHERE repository_id = ? AND kind = ? AND path = ?").get(repositoryId, kind, path) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  }

  /** 整类产物按文件路径归堆（读侧与报表用；一行一文件，不必解析整仓的大 JSON）。 */
  listFileFacts<T>(repositoryId: string, kind: FactKind): Map<string, T> {
    const rows = this.db.prepare("SELECT path, payload FROM static_fact WHERE repository_id = ? AND kind = ? ORDER BY path").all(repositoryId, kind) as { path: string; payload: string }[];
    return new Map(rows.map((row) => [row.path, JSON.parse(row.payload) as T]));
  }

  /** 某类产物各占多少文件、总共多少字节——「这项没做过」与「做了但都是空」在这里分开。 */
  factCoverage(repositoryId: string): { kind: FactKind; files: number; bytes: number }[] {
    const rows = this.db.prepare("SELECT kind, COUNT(*) AS files, SUM(LENGTH(payload)) AS bytes FROM static_fact WHERE repository_id = ? GROUP BY kind ORDER BY kind").all(repositoryId) as { kind: string; files: number; bytes: number }[];
    return rows.map((row) => ({ kind: row.kind as FactKind, files: row.files, bytes: row.bytes ?? 0 }));
  }

  /** 各批产物的计算时间（`lastAt` 是这一类最近一次重算）：给读侧说清「读数比代码旧多久」。 */
  factStamps(repositoryId: string): { kind: FactKind; files: number; firstAt: number; lastAt: number }[] {
    const rows = this.db.prepare("SELECT kind, COUNT(*) AS files, MIN(at) AS first_at, MAX(at) AS last_at FROM static_fact WHERE repository_id = ? GROUP BY kind ORDER BY kind").all(repositoryId) as { kind: string; files: number; first_at: number; last_at: number }[];
    return rows.map((row) => ({ kind: row.kind as FactKind, files: row.files, firstAt: row.first_at, lastAt: row.last_at }));
  }

  dropFileFacts(repositoryId: string, kind: FactKind, paths: string[]): void {
    if (!paths.length) return;
    const del = this.db.prepare("DELETE FROM static_fact WHERE repository_id = ? AND kind = ? AND path = ?");
    const tx = this.db.transaction((batch: string[]) => {
      for (const path of batch) del.run(repositoryId, kind, path);
    });
    tx(paths);
  }

  /**
    回合检查点（一个 super-step 一行）。同一回合的每一轮各写一行，续跑取最大 round 那行。
    `stoppedReason` 只在没走完那一次写：正常收尾走 clearTurnCheckpoints，留着的行就是没人收尾的残局。
    `pendingToolCallId` + `promptHash` 只有「等用户回答一句提问」那一档才两个都有——认领走下面那条查询，
    不走输入哈希（回灌的是用户的答句，本来就不是同一句话）。
  */
  saveTurnCheckpoint(input: { threadId: string; scene: string; round: number; inputHash: string; promptHash?: string; stoppedReason?: string; pendingToolCallId?: string; payload: unknown }): void {
    this.db.prepare("INSERT OR REPLACE INTO turn_checkpoint(thread_id, scene, round, input_hash, prompt_hash, stopped_reason, pending_tool_call_id, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.threadId, input.scene, input.round, input.inputHash, input.promptHash ?? null, input.stoppedReason ?? null, input.pendingToolCallId ?? null, JSON.stringify(input.payload), Date.now());
  }

  /**
    这个线程最近一轮的检查点；`inputHash` 对不上就不算「同一个问题」，宁可不续跑。
    等用户回答那档（`await_user`）在这里跳过：它等的下一句是答句、不是同一句话，
    让哈希那条路接上它就会「拿上一个问题的中间状态答这一句」，那正是这层一直防的事。
  */
  latestTurnCheckpoint<T>(threadId: string, scene: string, inputHash: string): { round: number; stoppedReason?: string; payload: T } | undefined {
    const row = this.db.prepare("SELECT round, stopped_reason, payload, input_hash FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND COALESCE(stopped_reason, '') <> 'await_user' ORDER BY round DESC LIMIT 1")
      .get(threadId, scene) as { round: number; stopped_reason: string | null; payload: string; input_hash: string } | undefined;
    if (!row || row.input_hash !== inputHash) return undefined;
    return { round: row.round, ...(row.stopped_reason ? { stoppedReason: row.stopped_reason } : {}), payload: JSON.parse(row.payload) as T };
  }

  /**
    认领一句提问：按挂着的调用 id 取，**取到即删**——用户答了，这条提问就此关闭，哪怕指纹核不上、
    哪怕手滑点了第二次，都不该再被结算或被另一份状态接走。
    `promptHash`（模型与系统提示）核不上回 `undefined`：接上另一家的中间状态等于答非所问，调用方按「老实重跑」处理。
  */
  claimTurnCheckpoint<T>(threadId: string, scene: string, pendingToolCallId: string, promptHash: string): { round: number; payload: T } | undefined {
    const row = this.db.prepare("SELECT round, payload, prompt_hash FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND pending_tool_call_id = ? ORDER BY round DESC LIMIT 1")
      .get(threadId, scene, pendingToolCallId) as { round: number; payload: string; prompt_hash: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND pending_tool_call_id = ?").run(threadId, scene, pendingToolCallId);
    if (row.prompt_hash !== promptHash) return undefined;
    return { round: row.round, payload: JSON.parse(row.payload) as T };
  }

  /**
    结算这条线程上挂着的提问：按 TTL 分成「过期」与「换话题」两档，**取出即删**——
    同一句提问不许在下一回合被再结算一次（报表里的 `discarded` 会因此翻倍）。
    `keepPendingToolCallId` 是这一句正要认领的那条：它不归这里管，留给 `claimTurnCheckpoint` 去读。
  */
  settlePendingAsks(threadId: string, scene: string, olderThan: number, keepPendingToolCallId?: string): { pendingToolCallId: string; cause: "expired" | "new_question" }[] {
    const rows = this.db.prepare("SELECT round, pending_tool_call_id, updated_at FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND pending_tool_call_id IS NOT NULL ORDER BY round DESC")
      .all(threadId, scene) as { pending_tool_call_id: string; updated_at: number }[];
    const remove = this.db.prepare("DELETE FROM turn_checkpoint WHERE thread_id = ? AND scene = ? AND pending_tool_call_id = ?");
    const settled: { pendingToolCallId: string; cause: "expired" | "new_question" }[] = [];
    for (const row of rows) {
      if (row.pending_tool_call_id === keepPendingToolCallId) continue;
      settled.push({ pendingToolCallId: row.pending_tool_call_id, cause: row.updated_at < olderThan ? "expired" : "new_question" });
      remove.run(threadId, scene, row.pending_tool_call_id);
    }
    return settled;
  }

  clearTurnCheckpoints(threadId: string, scene: string): number {
    return this.db.prepare("DELETE FROM turn_checkpoint WHERE thread_id = ? AND scene = ?").run(threadId, scene).changes;
  }

  /** 过期残局清理（TTL 是检查点膨胀的唯一解药；LangGraph 也要配 retention 同理）。 */
  pruneTurnCheckpoints(olderThan: number): number {
    return this.db.prepare("DELETE FROM turn_checkpoint WHERE updated_at < ?").run(olderThan).changes;
  }

  /** 检查点存量读数（报表用）：留了多少行、最旧的一行多久了。 */
  turnCheckpointStats(): { rows: number; oldestAt: number | null } {
    const row = this.db.prepare("SELECT COUNT(*) AS rows, MIN(updated_at) AS oldest_at FROM turn_checkpoint").get() as { rows: number; oldest_at: number | null };
    return { rows: row.rows, oldestAt: row.oldest_at ?? null };
  }

  /**
    文件摘要记录（L1）。summary 列是不透明 TEXT，内容是 JSON；读不出来就当未命中重算，不猜、不补默认值。
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

  /** `summaries.created_at` 每次写入都取当下（缓存命中也回写）：它是「最近一次被确认 / 刷新的时间」，不是首次生成时间。 */
  putFileSummary(cacheKey: string, value: { path: string; summary: string }): void {
    this.db.prepare("INSERT OR REPLACE INTO summaries(cache_key, summary, created_at) VALUES (?, ?, ?)")
      .run(cacheKey, JSON.stringify(value), new Date().toISOString());
  }

  /**
    每个文件最新的摘要（缓存键含切片与模型版本，同一文件有多行）；按写入时间倒序取每个路径的首次出现。
    limit 兜住只追加表的全表扫描；取不到 = 该文件没有已确认的职责，调用方按未知处理。
  */
  getLatestFileSummaries(limit = LATEST_SUMMARY_LIMIT): { path: string; summary: string; role?: string; coverageLow?: boolean }[] {
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
        // 非 JSON 行：跳过，当作没有这条摘要
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
    画布上的一张图（store/diagrams.ts 是唯一业务读写口，这里只收 SQL）。
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

  /**
    会话持久化（chat_session / chat_message）的语句层；业务出入口是 store/chat-store.ts（id/时间戳生成、入参守卫与领域类型在那里）。
    软删语义在此层落实：所有读侧带 deleted_at IS NULL，「列表看不见」与「消息行仍在」同时成立。
    */
  insertChatSession(session: { id: string; repositoryId: string; scope: string; scopeRef: string | null; exerciseId: string | null; title: string; at: string }): void {
    this.db.prepare(`INSERT INTO chat_session(id, repository_id, scope, scope_ref, exercise_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, session.repositoryId, session.scope, session.scopeRef, session.exerciseId, session.title, session.at, session.at);
  }

  getChatSession(sessionId: string): ChatSessionRow | undefined {
    return this.db.prepare("SELECT id, repository_id, scope, scope_ref, exercise_id, title, state_json, created_at, updated_at, deleted_at FROM chat_session WHERE id = ?").get(sessionId) as ChatSessionRow | undefined;
  }

  /** 未删会话列表：最近更新在前（GUI 的会话列表口径）。`limit` 兜住长期累积。 */
  /**
    会话清单：只回**已经有正文**的线程。
    零消息的 `chat_session` 行是正常中间态（新建先发行，第一条消息才落正文），但它不该进界面上的会话下拉——
    那里列的是「谈过的话」，不是「开着的空壳」。行本身留着不删：删行等于作废用户刚点的新建，而且界面还指着这个 id。
    `chat_message(session_id)` 上有索引，这条 EXISTS 不走全表。
  */
  listChatSessions(repositoryId: string, scope: string, limit = 100): ChatSessionRow[] {
    return this.db.prepare(`SELECT s.id, s.repository_id, s.scope, s.scope_ref, s.exercise_id, s.title, s.state_json, s.created_at, s.updated_at, s.deleted_at
      FROM chat_session s
      WHERE s.repository_id = ? AND s.scope = ? AND s.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM chat_message m WHERE m.session_id = s.id)
      ORDER BY s.updated_at DESC LIMIT ?`)
      .all(repositoryId, scope, limit) as ChatSessionRow[];
  }

  touchChatSession(sessionId: string, at: string): void {
    this.db.prepare("UPDATE chat_session SET updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, sessionId);
  }

  /** 问答线程的设置快照：续接会话时用同一套设置开下一轮。 */
  updateChatSessionState(sessionId: string, stateJson: string): void {
    this.db.prepare("UPDATE chat_session SET state_json = ? WHERE id = ? AND deleted_at IS NULL").run(stateJson, sessionId);
  }

  renameChatSession(sessionId: string, title: string, at: string): number {
    const result = this.db.prepare("UPDATE chat_session SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(title, at, sessionId);
    return result.changes;
  }

  /** 软删：只打时间戳，消息行与会话行都留在库里。已删的再删返回 0 行（幂等判据由调用方看 changes）。 */
  softDeleteChatSession(sessionId: string, at: string): number {
    const result = this.db.prepare("UPDATE chat_session SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, sessionId);
    return result.changes;
  }

  /** 正文行入库。stage 是遗留列，一律不写不读，留着不迁移。 */
  insertChatMessage(message: { id: string; sessionId: string; role: string; content: string; createdAt: string; error: string | null }): void {
    this.db.prepare("INSERT INTO chat_message(id, session_id, role, content, created_at, error) VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.id, message.sessionId, message.role, message.content, message.createdAt, message.error);
  }

  /** 取会话正文：未删会话才有内容（会话已删时调用方拿到空数组，等于「这个会话不存在」）。
      给了 `limit` 就是尾窗语义——先倒序取最近 limit 条再反转回升序，调用方拿到的永远是时间正序。
      定序用 `rowid`（SQLite 插入序）而不是 `id`：id 是随机 UUID，按它排会把同一回合的 user/assistant 排反。 */
  listChatMessages(sessionId: string, limit?: number): ChatMessageRow[] {
    const base = `SELECT m.id, m.session_id, m.role, m.content, m.created_at, m.error
      FROM chat_message m JOIN chat_session s ON s.id = m.session_id
      WHERE m.session_id = ? AND s.deleted_at IS NULL`;
    if (!limit) {
      return this.db.prepare(`${base} ORDER BY m.rowid ASC`).all(sessionId) as ChatMessageRow[];
    }
    const tail = this.db.prepare(`${base} ORDER BY m.rowid DESC LIMIT ?`).all(sessionId, limit) as ChatMessageRow[];
    return tail.reverse();
  }

  /** 某会话的消息条数（含已软删会话的行——用于机检「删除只动标记，不动原文」）。 */
  countChatMessages(sessionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM chat_message WHERE session_id = ?").get(sessionId) as { count: number };
    return row.count;
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

