import type { ChatScope, ChatThread, ChatThreadMessage, TeachingStage, TutorSettings } from "@codebase-tutor/shared";
import { id } from "../lib.js";
import { TutorDatabase, type ChatMessageRow, type ChatSessionRow } from "./database.js";

/**
  会话持久化的唯一出入口（产品数据线，不是审计线）。

  三条口径要说清楚：
  - **正文不截断**。2000 字截断只属于 journal 的 `turn_text`（审计摘要）；这里的原文是给上下文注入和
    GUI 重放用的，截了就把「学习者实际问过什么」改写了。两条线各记各的，差异是刻意的。
  - **删除是软的**。`softDeleteThread` 只打 `deleted_at`，消息行留在库里——GUI 列表读不到，
    journal（另一条 append-only 线）完全不受影响。产品删除永远不动审计。
  - **仓库归属用 `repository_id`**（= `sha256(realpath)` 前缀，确定性可重算）。仓库被移动/改名时
    老行查不到，表现与「会话自然过期」一致，不额外兜底。

  每个函数自开自闭一个 `TutorDatabase`：引擎里 DB 句柄不作长驻（与 cost/settings 读取同一做法），
  免得连接生命周期和 tsx 热重载缠在一起。开闭都走 `withDatabase`，不在各函数里手写 `close()`。
  */

const SCOPES: ChatScope[] = ["teach", "map", "practice"];
const TITLE_MAX = 120;

/**
  唯一的一处「开连接 → 用 → 关」。写在 try/finally 而不是每个函数末尾 `database.close()`：
  这些函数挂在每个对话回合的读写路径上，SQL 出错 / 库文件被外部换掉时抛错，
  尾置的 `close()` 就跳过了一次，攒够直接把进程拖到 EMFILE。
  */
function withDatabase<T>(repositoryPath: string, run: (database: TutorDatabase) => T): T {
  const database = new TutorDatabase(repositoryPath);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

export function isChatScope(value: unknown): value is ChatScope {
  return typeof value === "string" && (SCOPES as string[]).includes(value);
}

function threadOf(row: ChatSessionRow): ChatThread {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    scope: row.scope as ChatScope,
    ...(row.course_node_id ? { courseNodeId: row.course_node_id } : {}),
    ...(row.exercise_id ? { exerciseId: row.exercise_id } : {}),
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function messageOf(row: ChatMessageRow): ChatThreadMessage {
  return {
    id: row.id,
    role: row.role as "user" | "assistant",
    content: row.content,
    createdAt: row.created_at,
    ...(row.stage ? { stage: row.stage as TeachingStage } : {}),
    ...(row.error ? { error: row.error } : {})
  };
}

/** 标题：调用方（或首问）给的文本截到 120 字；空则落作用域占位名，不写「未命名」这种要二次改的假值。 */
function normalizeTitle(title: string | undefined, scope: ChatScope): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed.slice(0, TITLE_MAX);
  return scope === "teach" ? "新的教学会话" : scope === "map" ? "新的宏观设计对话" : "新的练习对话";
}

export function createThread(input: { repositoryPath: string; repositoryId: string; scope: ChatScope; title?: string; courseNodeId?: string; exerciseId?: string; /** 会话 id 由调用方持有时传进来（教学作用域的 id 是 `createSession` 生成的），不传则现生成。 */ id?: string }): ChatThread {
  const now = new Date().toISOString();
  const thread: ChatThread = {
    id: input.id ?? id(),
    repositoryId: input.repositoryId,
    scope: input.scope,
    ...(input.courseNodeId ? { courseNodeId: input.courseNodeId } : {}),
    ...(input.exerciseId ? { exerciseId: input.exerciseId } : {}),
    title: normalizeTitle(input.title, input.scope),
    createdAt: now,
    updatedAt: now
  };
  withDatabase(input.repositoryPath, (database) => database.insertChatSession({
    id: thread.id,
    repositoryId: thread.repositoryId,
    scope: thread.scope,
    courseNodeId: thread.courseNodeId ?? null,
    exerciseId: thread.exerciseId ?? null,
    title: thread.title,
    at: now
  }));
  return thread;
}

/** 线程头（含已软删的也会返回 `undefined`——调用方按「不存在」处理，不给 GUI 区分两种形态的机会）。 */
export function getThread(repositoryPath: string, threadId: string): ChatThread | undefined {
  const row = withDatabase(repositoryPath, (database) => database.getChatSession(threadId));
  return row && !row.deleted_at ? threadOf(row) : undefined;
}

export function listThreads(repositoryPath: string, repositoryId: string, scope: ChatScope, limit = 100): ChatThread[] {
  const rows = withDatabase(repositoryPath, (database) => database.listChatSessions(repositoryId, scope, limit));
  return rows.map(threadOf);
}

/** 按节点找回最近一次教学会话（GUI 本地没存过 id 时的入口）。 */
export function latestThreadForNode(repositoryPath: string, repositoryId: string, courseNodeId: string): ChatThread | undefined {
  const row = withDatabase(repositoryPath, (database) => database.getLatestChatSessionByNode(repositoryId, courseNodeId));
  return row ? threadOf(row) : undefined;
}

export interface NewMessage {
  role: "user" | "assistant";
  content: string;
  stage?: TeachingStage;
  error?: string;
}

/**
  追加消息并续期 `updated_at`（会话列表的排序键）。
  线程不存在或已软删返回 `false`——写入被静默丢弃是不可接受的，调用方（路由）要据此报错而不是继续。
  */
export function appendMessages(repositoryPath: string, threadId: string, messages: NewMessage[]): boolean {
  return withDatabase(repositoryPath, (database) => {
    const session = database.getChatSession(threadId);
    if (!session || session.deleted_at) return false;
    const now = new Date().toISOString();
    for (const message of messages) {
      database.insertChatMessage({
        id: id(),
        sessionId: threadId,
        role: message.role,
        content: message.content,
        createdAt: now,
        stage: message.stage ?? null,
        error: message.error ?? null
      });
    }
    database.touchChatSession(threadId, now);
    return true;
  });
}

/**
  教学回合的状态快照：状态机接着走需要的三样（档位设置 / stage / fallback 计数）。
  map/practice 没有状态机，这两函数只对 scope='teach' 有意义。

  读侧**不做兜底**：缺字段就返回 `undefined`，调用方按「这轮没有可续的状态」处理——
  把「没记」伪装成默认值，等于让会话从 orient 假装重来一遍。
  */
export interface TeachingThreadState {
  stage: TeachingStage;
  fallbackCount: number;
  settings: TutorSettings;
}

const STAGES: TeachingStage[] = ["orient", "procedure", "concept", "verify", "confirmed"];

/** 宽松读：只保证形状对（字段齐、枚举合法、计数非负整数）；settings 的逐字段归型留给 validateSettings。 */
export function readThreadState(repositoryPath: string, threadId: string): TeachingThreadState | undefined {
  const row = withDatabase(repositoryPath, (database) => database.getChatSession(threadId));
  if (!row?.state_json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.state_json);
  } catch {
    return undefined;
  }
  const state = parsed as Partial<TeachingThreadState> | null;
  if (!state || typeof state !== "object") return undefined;
  if (typeof state.stage !== "string" || !(STAGES as string[]).includes(state.stage)) return undefined;
  if (typeof state.fallbackCount !== "number" || !Number.isInteger(state.fallbackCount) || state.fallbackCount < 0) return undefined;
  if (!state.settings || typeof state.settings !== "object") return undefined;
  return { stage: state.stage as TeachingStage, fallbackCount: state.fallbackCount, settings: state.settings };
}

/** 全量覆盖状态快照（回合收尾时写；不改 `updated_at`，那由 appendMessages 负责）。已软删线程返回 false。 */
export function saveThreadState(repositoryPath: string, threadId: string, state: TeachingThreadState): boolean {
  return withDatabase(repositoryPath, (database) => {
    const row = database.getChatSession(threadId);
    if (!row || row.deleted_at) return false;
    database.updateChatSessionState(threadId, JSON.stringify(state));
    return true;
  });
}

/** 全量或尾窗正文：`limit` 取最近 limit 条（仍按时间正序返回）。已软删的线程返回空数组。 */
export function readMessages(repositoryPath: string, threadId: string, limit?: number): ChatThreadMessage[] {
  const rows = withDatabase(repositoryPath, (database) => database.listChatMessages(threadId, limit));
  return rows.map(messageOf);
}

/** 改名：标题去空后截 120 字；空标题或线程不存在/已删返回 `undefined`（路由据此回 400/404）。 */
export function renameThread(repositoryPath: string, threadId: string, title: string): ChatThread | undefined {
  const trimmed = title.trim().slice(0, TITLE_MAX);
  if (!trimmed) return undefined;
  const row = withDatabase(repositoryPath, (database) => {
    const changed = database.renameChatSession(threadId, trimmed, new Date().toISOString());
    return changed ? database.getChatSession(threadId) : undefined;
  });
  return row && !row.deleted_at ? threadOf(row) : undefined;
}

/** 软删：返回是否真的删掉了一条未删线程（重复删第二次返回 false，供路由回 404）。 */
export function softDeleteThread(repositoryPath: string, threadId: string): boolean {
  return withDatabase(repositoryPath, (database) => database.softDeleteChatSession(threadId, new Date().toISOString())) > 0;
}

/** 机检与脚本用：正文行数。走**未过滤**的计数，所以软删线程的行仍然数得到——用来证明「删除没动原文」。 */
export function countMessagesRaw(repositoryPath: string, threadId: string): number {
  return withDatabase(repositoryPath, (database) => database.countChatMessages(threadId));
}
