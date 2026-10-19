import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CourseTree, FactKind, ImportEstimate, MasteryRecord, RepositoryAnalysis, RepositoryIndex, ReviewSchedule } from "@codebase-tutor/shared";
import { loadAddon } from "./betterSqlite3Loader.cjs";

const schemaVersion = 8;

// 一次性 pre-load：dlopen 对应当前 Node ABI 的 binding 路径，避免 better-sqlite3
// 走默认 `bindings('better_sqlite3.node')` 触发 127↔147 mismatch。
// 后端只需 `new Database(filename, { nativeBinding })` 即可。
// 类型 cast 是因为 @types/better-sqlite3 只声明了 `nativeBinding: string`，但
// runtime 接受 addon 对象（见 better-sqlite3/lib/database.js 注释 "string or addon object"）。
const nativeBinding = loadAddon() as unknown as string;

/**
  `getLatestFileSummaries` 的默认行数上限，**同时导出给调用方做达到预算上限判据**——
  两处各写一个 2000 的话，改一处就会让「读到上限」的告警永远不响（§37.6 那条「一份清单改了两处」的同型坑）。
*/
export const LATEST_SUMMARY_LIMIT = 2_000;

/** layer_cache 的按龄修剪线：键是输入精确哈希，过期条目只是占空间的垃圾，不存在「过期还在被信任」。 */
const LAYER_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** chat_session 的行形状（snake_case 贴着表；域类型转换在 store/chat-store.ts）。 */
export interface ChatSessionRow {
  id: string;
  repository_id: string;
  scope: string;
  course_node_id: string | null;
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

/** 检索向量的解码口径，与 `saveVectors` 的写入配方成对。评测台架自己开只读句柄取行，必须走这里同一个函数——两臂读两套坐标系就什么也没比。 */
export function decodeVectorBlob(path: string, dim: number, bytes: Uint8Array): { path: string; dim: number; vec: Float32Array } {
  const copy = new Uint8Array(bytes); // 驱动给的 Buffer 可能被复用，拷一份再视图化
  return { path, dim, vec: new Float32Array(copy.buffer, copy.byteOffset, dim) };
}

/**
  产物库的**唯一形状声明**。它同时是两样东西的源：
  - `migrate()` 里的 `db.exec`（建缺失的表）；
  - 列对账（`reconcileColumns`）——从这段文本里读出每张表应有的列，缺哪补哪。

  为什么列对账必须存在：`CREATE TABLE IF NOT EXISTS` 对**已经存在的表**一个列都不加。
  这条梯子过去有四个版本（v3/v4/v5/v6/v8）只推版本号不建 DDL，于是「往上面的声明里加一列」
  在新仓成立、在用户已有的 .tutor/tutor.db 上静默不成立——要到第一次真读那一列才炸。
  v7 当初就是为 `state_json` 手补的一条 PRAGMA 守卫；补得了一次补不了次次，现在变成机制。
  */
export const DATABASE_SCHEMA_SQL = `
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
      -- 【已退役，2026-10-18】「agent 重绘后待替换」那张过渡图住的表：宏观设计改成图库 + 自由画布之后，
      -- 结构改动直接落在下面的 diagram 表上，pending/preview 这套三态机没有了。
      -- 表与历史行都留着：老仓里可能还躺着一份用户点过头的判断，删表等于把他的记录毁了，
      -- 而留着不读的成本是零（同一道理见上面 repository_state 那几列的注释）。
      CREATE TABLE IF NOT EXISTS diagram_artifact (
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        purpose TEXT NOT NULL,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY(repository_id, kind, status)
      );
      -- 画布上的一张图（store/diagrams.ts 是唯一读写口）。一行 = 一张图，一个仓可以有很多张。
      -- **刻意不住在 layer_cache 里**：那张表每次写入都按 at 无差别删掉 7 天前的行，
      -- 语义是「输入变了就没人再命中的缓存」；而图是用户资产，闲置九十天后被一次无关写入清掉就是丢数据。
      -- 名字/来源/时间戳单独立列：图库列表只要这几格，不必把整张图的 JSON 解析一遍。
      CREATE TABLE IF NOT EXISTS diagram (
        repository_id TEXT NOT NULL,
        diagram_id TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(repository_id, diagram_id)
      );
      CREATE TABLE IF NOT EXISTS chat_session (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        course_node_id TEXT,
        exercise_id TEXT,
        title TEXT NOT NULL,
        -- 问答线程的设置快照 {settings}（map/practice 为 NULL）。
        -- 2026-10-14 撤掉教学状态机后这里不再存 stage/fallbackCount，只剩「下一轮接着用哪套设置」。
        -- 这些值过去靠 journal 的 hint_depth/style_shift 重放推出（restore.ts），现在直接住在产品数据线里。
        state_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS chat_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_session(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        -- 教学阶段戳：状态机时代的遗留列，2026-10-14 起不再写入也不再读；
        -- 列留着不删——tutor.db 是随仓可带走的东西，历史行里的值得在，删列要迁移而收益是零。
        stage TEXT,
        error TEXT
      );
      -- 检索第四臂的向量表（2026-10-04）。键是 (仓, 文件, embedding 模型)：
      -- 换模型就是换一套坐标系，不能混用；content_hash 让「文件没改」直接等于「不用重嵌」。
      -- 向量存 float32 小端 BLOB，相似度在 JS 里算（几百~几千条，扫一遍是毫秒级，不引 sqlite-vec 原生扩展）。
      CREATE TABLE IF NOT EXISTS search_vector (
        repository_id TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        vec BLOB NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY(repository_id, path, model)
      );
      -- 静态产物层（2026-10-19）：控制流图、数据流、类型关系、注册与配置索引，按文件一行。
      -- 为什么不进 repository_state.analysis_json：那一列已经是大仓里最重的一块，而且它的指纹
      -- （backendStamp）参与宏观润色的复用判定——把新产物塞进去等于每加一类分析就翻一次全仓的键。
      -- 为什么不进 layer_cache：那张表每次写入都按 at 删掉 7 天前的行，而这里的东西是确定性重算的，
      -- 只要源码没改就一直有效，被无关写入清掉就得白重算一遍。
      -- 一文件一行而不是整仓一行：读侧只取要的那几个文件，不必把整仓的图解析一遍。
      CREATE TABLE IF NOT EXISTS static_fact (
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY(repository_id, kind, path)
      );
      CREATE INDEX IF NOT EXISTS chat_message_session ON chat_message(session_id, created_at);
      CREATE INDEX IF NOT EXISTS chat_session_repo ON chat_session(repository_id, scope, deleted_at);
`;

/** 声明里的约束列：ADD COLUMN 加不出这些，缺了必须写真迁移（带回填的那种）。 */
const NOT_ADDABLE = /\b(PRIMARY|UNIQUE|REFERENCES|CHECK)\b/i;

/** 表级约束行（不是列声明）：`PRIMARY KEY(a, b)` 那种整行要跳过。 */
const TABLE_CONSTRAINT = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i;

/**
  声明文本 → 每张表的列清单。
  边界取「到第一个 `;` 为止」而不是「到单独一行的 `);` 为止」：`schema_version` 是单行写的
  `CREATE TABLE … (version INTEGER NOT NULL);`，按换行收尾会把下一张表的列算到它头上
  （这条测试第一天就抓到了这个错切法）。建表语句内部没有分号，所以这个边界是安全的。
  */
export function declaredColumns(schema: string): { table: string; column: string; declaration: string }[] {
  const clean = schema.replace(/--[^\n]*/g, "");
  const out: { table: string; column: string; declaration: string }[] = [];
  for (const match of clean.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([^;]*)\)\s*;/g)) {
    const table = match[1];
    for (const entry of splitTopLevel(match[2])) {
      const declaration = entry.trim().replace(/\s+/g, " ");
      if (!declaration || TABLE_CONSTRAINT.test(declaration)) continue;
      out.push({ table, column: declaration.split(" ")[0], declaration });
    }
  }
  return out;
}

/** 按顶层逗号切列声明：`PRIMARY KEY(a, b)` 里面的逗号不算分隔。 */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

export class TutorDatabase {
  private readonly db: Database.Database;
  /** 开库所在的路径（只为把告警说成「哪个仓的库」，不参与任何判据）。 */
  readonly repositoryPathLabel: string;
  /**
    对账没能补上的列（`表.列`）。空数组 = 这份库的形状等于声明。
    交出来而不是抛，是为了不把用户的存量库变成打不开的东西；挂载时这条读数会进 `engine.jsonl`。
    */
  readonly schemaGaps: string[] = [];

  constructor(readonly repositoryPath: string) {
    const tutorDir = join(repositoryPath, ".tutor");
    if (!existsSync(tutorDir)) mkdirSync(tutorDir, { recursive: true });
    this.repositoryPathLabel = repositoryPath;
    this.db = new Database(join(tutorDir, "tutor.db"), { nativeBinding });
    this.db.pragma("journal_mode = WAL");
    this.migrate();
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
      this.db.exec("ALTER TABLE repository_state ADD COLUMN analysis_json TEXT;");
      this.db.exec("ALTER TABLE repository_state ADD COLUMN settings_json TEXT;");
      this.db.prepare("UPDATE schema_version SET version = ?").run(2);
    }
    if (current.version < 3) this.db.prepare("UPDATE schema_version SET version = ?").run(3);
    if (current.version < 4) this.db.prepare("UPDATE schema_version SET version = ?").run(4);
    if (current.version < 5) this.db.prepare("UPDATE schema_version SET version = ?").run(5);
    // v6：会话持久化两表（上面 CREATE IF NOT EXISTS 幂等建好，这里只推版本号）
    if (current.version < 6) this.db.prepare("UPDATE schema_version SET version = ?").run(6);
    if (current.version < 7) {
      // v7：chat_session 加 state_json。守卫是必需的而不是保险——
      // 老库（v5/v6 之前）走上面的 CREATE 时已经带了这一列，无脑 ALTER 会抛 duplicate column。
      const hasState = (this.db.prepare("PRAGMA table_info(chat_session)").all() as { name: string }[]).some((column) => column.name === "state_json");
      if (!hasState) this.db.exec("ALTER TABLE chat_session ADD COLUMN state_json TEXT;");
      this.db.prepare("UPDATE schema_version SET version = ?").run(schemaVersion);
    }
    // v8：检索向量表（上面 CREATE 幂等建好，这里只推版本号）
    if (current.version < 8) this.db.prepare("UPDATE schema_version SET version = ?").run(8);
    /**
      列对账放在梯子**之后**：v2/v7 那两步会补它们各自认识的列，先对账会让梯队的 ALTER 撞 duplicate column。
      对账兜的是「改了声明而没写梯子」那一类——v3/v4/v5/v6/v8 只推版本号不建 DDL，
      那几版往 CREATE 里加的列在存量库上从来没有落地，而这件事当时没有任何读数会红。
      */
    this.reconcileColumns(schema);
    if (current.version > schemaVersion) {
      throw new Error(`Unsupported .tutor schema version ${current.version}`);
    }
  }

  /**
    列对账：以声明文本为唯一源，把「声明里有、这张表还没有」的列补上。
    每次都跑、幂等——所以它不依赖版本号是否被翻对（那正是过去四个版本只推号不建 DDL 漏掉的东西）。
    补不上的（带约束、或 NOT NULL 又没默认值）记进 `schemaGaps` 并当场喊一声，**不抛**：
    崩在开库上等于把用户已有的学习记录整个锁死，而那一列下一次被真读到时自然会失败——
    失败点带得出具体列名，比开机一句「Unsupported schema」有用得多。
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

  saveCourse(tree: CourseTree, estimate: ImportEstimate): void {
    this.upsert(tree.repositoryId, { course: JSON.stringify(tree), estimate: JSON.stringify(estimate) });
  }

  saveAnalysis(analysis: RepositoryAnalysis): void {
    this.upsert(analysis.repositoryId, { analysis: JSON.stringify(analysis) });
  }

  getIndex(repositoryId: string): RepositoryIndex | undefined {
    const value = this.getJsonColumn(repositoryId, "index_json");
    return value ? JSON.parse(value) as RepositoryIndex : undefined;
  }

  getCourse(repositoryId: string): CourseTree | undefined {
    const value = this.getJsonColumn(repositoryId, "course_json");
    return value ? JSON.parse(value) as CourseTree : undefined;
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
    写一批文件级静态产物。`replaceAll` 表示这批就是该产物的全集（整仓重算时用，删掉已消失文件的行）；
    不传则是按文件增改——增量重分析只重写受影响文件的行，其余文件的产物仍然有效，不该跟着丢。
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
    旧键（输入变了）永远不会再被命中，靠 `putLayerCache` 顺带按龄修剪兜底，防止无限累积。
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

  /**
    画布上的一张图（`store/diagrams.ts` 是唯一业务读写口，这里只收 SQL；表结构与「为什么单独立列」见上面 `diagram` 那段）。
    ⚠️ 列一律 `AS` 成返回类型上那几个驼峰名：better-sqlite3 按 **SQL 里写的列名**交回键，
    而这里的类型声明是驼峰的——`created_at` 不写别名的话 `row.createdAt` 是 `undefined`，
    编译器一句都不报（类型是断言出来的），到运行期才炸成「Invalid time value」。
    与 `chat_session` 那种「类型就写蛇形」的行形状是另一条路，两条都行，但**声明与交出的键必须是同一套**。
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
    会话持久化（chat_session / chat_message）的语句层。
    业务出入口是 `store/chat-store.ts`——那里负责 id/时间戳生成、入参守卫与领域类型，
    这一层只把 SQL 收在一处。软删语义在此层就要落实：**所有读侧带 `deleted_at IS NULL`**，
    所以「列表看不见」与「消息行仍在」可以同时成立（产品删除不动审计线，也不动消息原文）。
    */
  insertChatSession(session: { id: string; repositoryId: string; scope: string; courseNodeId: string | null; exerciseId: string | null; title: string; at: string }): void {
    this.db.prepare(`INSERT INTO chat_session(id, repository_id, scope, course_node_id, exercise_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, session.repositoryId, session.scope, session.courseNodeId, session.exerciseId, session.title, session.at, session.at);
  }

  getChatSession(sessionId: string): ChatSessionRow | undefined {
    return this.db.prepare("SELECT id, repository_id, scope, course_node_id, exercise_id, title, state_json, created_at, updated_at, deleted_at FROM chat_session WHERE id = ?").get(sessionId) as ChatSessionRow | undefined;
  }

  /** 未删会话列表：最近更新在前（GUI 的会话列表口径）。`limit` 兜住长期累积。 */
  listChatSessions(repositoryId: string, scope: string, limit = 100): ChatSessionRow[] {
    return this.db.prepare("SELECT id, repository_id, scope, course_node_id, exercise_id, title, state_json, created_at, updated_at, deleted_at FROM chat_session WHERE repository_id = ? AND scope = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?")
      .all(repositoryId, scope, limit) as ChatSessionRow[];
  }

  /** 按节点找回最近一次教学会话（GUI 本地没存过 id 时用）：未删、最近更新在前。 */
  getLatestChatSessionByNode(repositoryId: string, courseNodeId: string): ChatSessionRow | undefined {
    return this.db.prepare("SELECT id, repository_id, scope, course_node_id, exercise_id, title, state_json, created_at, updated_at, deleted_at FROM chat_session WHERE repository_id = ? AND scope = 'teach' AND course_node_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1")
      .get(repositoryId, courseNodeId) as ChatSessionRow | undefined;
  }

  touchChatSession(sessionId: string, at: string): void {
    this.db.prepare("UPDATE chat_session SET updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(at, sessionId);
  }

  /** 问答线程的设置快照（settings）——会话续命靠它把下一轮的档位接回上一轮用的那一套。 */
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

  /** 正文行入库。`stage` 列一律写 NULL（教学状态机已于 2026-10-14 撤掉，列留着不迁移）。 */
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

  /** 检索向量：某模型下已存的 path → content_hash（决定哪些文件需要重嵌）。 */
  getVectorHashes(repositoryId: string, model: string): Map<string, string> {
    const rows = this.db.prepare("SELECT path, content_hash FROM search_vector WHERE repository_id = ? AND model = ?").all(repositoryId, model) as { path: string; content_hash: string }[];
    return new Map(rows.map((row) => [row.path, row.content_hash]));
  }

  saveVectors(repositoryId: string, model: string, vectors: { path: string; dim: number; contentHash: string; vec: Float32Array }[]): void {
    if (!vectors.length) return;
    const insert = this.db.prepare("INSERT OR REPLACE INTO search_vector(repository_id, path, model, dim, content_hash, vec, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const at = new Date().toISOString();
    const tx = this.db.transaction((rows: { path: string; dim: number; contentHash: string; vec: Float32Array }[]) => {
      for (const row of rows) insert.run(repositoryId, row.path, model, row.dim, row.contentHash, Buffer.from(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength), at);
    });
    tx(vectors);
  }

  loadVectors(repositoryId: string, model: string): { path: string; dim: number; vec: Float32Array }[] {
    // ORDER BY path：dense 臂的扫描顺序固定下来（同分排名本来按路径破平，但扫描顺序不定会让「两次跑同样输入」
    // 在浮点边界上有理论差异的可能——可复现性不留这个口子）
    const rows = this.db.prepare("SELECT path, dim, vec FROM search_vector WHERE repository_id = ? AND model = ? ORDER BY path").all(repositoryId, model) as { path: string; dim: number; vec: Uint8Array }[];
    return rows.map((row) => decodeVectorBlob(row.path, row.dim, row.vec));
  }

  /** 文件已从索引里消失（或被改名）时删掉它的向量——留着只会让 dense 臂返回不存在的路径。 */
  pruneVectors(repositoryId: string, model: string, keepPaths: string[]): number {
    const keep = new Set(keepPaths);
    const rows = this.db.prepare("SELECT path FROM search_vector WHERE repository_id = ? AND model = ?").all(repositoryId, model) as { path: string }[];
    const del = this.db.prepare("DELETE FROM search_vector WHERE repository_id = ? AND model = ? AND path = ?");
    let removed = 0;
    for (const row of rows) if (!keep.has(row.path)) { del.run(repositoryId, model, row.path); removed += 1; }
    return removed;
  }

  close(): void {
    this.db.close();
  }

  /**
    一次只取要的**那一列**。以前五个 getter 全走「SELECT 全部五列」，而 `analysis_json` 是大仓里最重的一块
    （依赖图 + 符号表 + 质量报告，整仓序列化），于是「只想读 settings 里那个月预算」也要把它几十 MB 捞一遍。
    列名取自这张表的固定五个，不接受任何外部字符串，拼进 SQL 不构成注入面。
    */
  private getJsonColumn(repositoryId: string, column: "index_json" | "course_json" | "estimate_json" | "analysis_json" | "settings_json"): string | null | undefined {
    const row = this.db.prepare(`SELECT ${column} AS value FROM repository_state WHERE repository_id = ?`).get(repositoryId) as { value: string | null } | undefined;
    return row?.value;
  }

  /**
    只写这次给出来的那几列。旧写法是「SELECT 全部五列 → 拼回七列 INSERT OR REPLACE」，
    所以「存一份 settings」也要把最重的 `analysis_json` 读出来再原样写回去；
    `ON CONFLICT DO UPDATE` 只碰给了值的列，其余留在原地不动。
    列名从这张表固定的五个键里查，外部字符串进不了 SQL。
    */
  private upsert(repositoryId: string, patch: { index?: string; course?: string; estimate?: string; analysis?: string; settings?: string }): void {
    const columnOf = { index: "index_json", course: "course_json", estimate: "estimate_json", analysis: "analysis_json", settings: "settings_json" } as const;
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

