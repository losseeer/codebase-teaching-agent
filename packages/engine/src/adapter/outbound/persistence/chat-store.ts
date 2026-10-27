import type { ChatScope, ChatThread, ChatThreadMessage } from "@codebase-tutor/contract";
import type { TutorSettings } from "@codebase-tutor/domain";

import { id } from "@codebase-tutor/platform";
import { type ChatMessageRow, type ChatSessionRow } from "./chat-repository.js";
import { withDatabase } from "./database.js";

/**
  会话持久化的唯一出入口（产品数据线，不是审计线）。三条口径：
  - 正文不截断。2000 字截断只属于 journal 的 turn_text（审计摘要）；这里的原文给上下文注入与 GUI 重放用。两条线各记各的。
  - 删除是软的。softDeleteThread 只打 deleted_at，消息行留在库里；journal（append-only 审计线）不受影响。
  - 仓库归属用 repository_id（= sha256(realpath) 前缀，确定性可重算）。仓库被移动/改名时老行查不到，表现同「会话自然过期」。

  每个函数自开自闭一个 TutorDatabase（DB 句柄不作长驻），开闭都走 withDatabase，不在各函数里手写 close()。
  */

const SCOPES: ChatScope[] = ["teach", "map", "practice"];
const TITLE_MAX = 120;

/**
  唯一的一处「开连接 → 用 → 关」在 `persistence/database.ts` 的 `withDatabase`：这些函数挂在每个对话回合的读写路径上。
  */

export function isChatScope(value: unknown): value is ChatScope {
  return typeof value === "string" && (SCOPES as string[]).includes(value);
}

function threadOf(row: ChatSessionRow): ChatThread {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    scope: row.scope as ChatScope,
    ...(row.scope_ref ? { scopeRef: row.scope_ref } : {}),
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
    ...(row.error ? { error: row.error } : {})
  };
}

/** 标题：调用方（或首问）给的文本截到 120 字；空则落作用域占位名，不写「未命名」这种要二次改的假值。 */
function normalizeTitle(title: string | undefined, scope: ChatScope): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed.slice(0, TITLE_MAX);
  return scope === "teach" ? "新的教学会话" : scope === "map" ? "新的宏观设计对话" : "新的练习对话";
}

// 会话 id 由调用方持有时传进来（教学作用域的 id 是 createSession 生成的），不传则现生成。
export function createThread(input: { repositoryPath: string; repositoryId: string; scope: ChatScope; title?: string; scopeRef?: string; exerciseId?: string; id?: string }): ChatThread {
  const now = new Date().toISOString();
  const thread: ChatThread = {
    id: input.id ?? id(),
    repositoryId: input.repositoryId,
    scope: input.scope,
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    ...(input.exerciseId ? { exerciseId: input.exerciseId } : {}),
    title: normalizeTitle(input.title, input.scope),
    createdAt: now,
    updatedAt: now
  };
  withDatabase(input.repositoryPath, (database) => database.chats.insertSession({
    id: thread.id,
    repositoryId: thread.repositoryId,
    scope: thread.scope,
    scopeRef: thread.scopeRef ?? null,
    exerciseId: thread.exerciseId ?? null,
    title: thread.title,
    at: now
  }));
  return thread;
}

/** 线程头（含已软删的也会返回 `undefined`——调用方按「不存在」处理，不给 GUI 区分两种形态的机会）。 */
export function getThread(repositoryPath: string, threadId: string): ChatThread | undefined {
  const row = withDatabase(repositoryPath, (database) => database.chats.session(threadId));
  return row && !row.deleted_at ? threadOf(row) : undefined;
}

/** 会话列表：按最近更新在前，**只含已有正文的线程**（判据在 `persistence/chat-repository.ts` 的 `sessions`，一处）。 */
export function listThreads(repositoryPath: string, repositoryId: string, scope: ChatScope, limit = 100): ChatThread[] {
  const rows = withDatabase(repositoryPath, (database) => database.chats.sessions(repositoryId, scope, limit));
  return rows.map(threadOf);
}

export interface NewMessage {
  role: "user" | "assistant";
  content: string;
  error?: string;
}

/**
  追加消息并续期 `updated_at`（会话列表的排序键）。
  线程不存在或已软删返回 `false`——写入被静默丢弃是不可接受的，调用方（路由）要据此报错而不是继续。
  */
export function appendMessages(repositoryPath: string, threadId: string, messages: NewMessage[]): boolean {
  return withDatabase(repositoryPath, (database) => {
    const session = database.chats.session(threadId);
    if (!session || session.deleted_at) return false;
    const now = new Date().toISOString();
    for (const message of messages) {
      database.chats.insertMessage({
        id: id(),
        sessionId: threadId,
        role: message.role,
        content: message.content,
        createdAt: now,
        error: message.error ?? null
      });
    }
    database.chats.touchSession(threadId, now);
    return true;
  });
}

/**
  问答线程的状态快照：只剩设置这一个节点（只有 scope='teach' 的线程写；历史行里的多余键读侧忽略，不迁移）。
  读侧不做兜底：settings 不齐就返回 undefined，调用方按「这轮没有可续的状态」处理——不把「没记」伪装成默认值。
  */
export interface TeachingThreadState {
  settings: TutorSettings;
}

/** 宽松读：只保证形状对（settings 在场）；逐字段归型留给 validateSettings。 */
export function readThreadState(repositoryPath: string, threadId: string): TeachingThreadState | undefined {
  const row = withDatabase(repositoryPath, (database) => database.chats.session(threadId));
  if (!row?.state_json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.state_json);
  } catch {
    return undefined;
  }
  const state = parsed as Partial<TeachingThreadState> | null;
  if (!state || typeof state !== "object") return undefined;
  if (!state.settings || typeof state.settings !== "object") return undefined;
  return { settings: state.settings };
}

/** 全量覆盖状态快照（回合收尾时写；不改 `updated_at`，那由 appendMessages 负责）。已软删线程返回 false。 */
export function saveThreadState(repositoryPath: string, threadId: string, state: TeachingThreadState): boolean {
  return withDatabase(repositoryPath, (database) => {
    const row = database.chats.session(threadId);
    if (!row || row.deleted_at) return false;
    database.chats.saveState(threadId, JSON.stringify(state));
    return true;
  });
}

/** 全量或尾窗正文：`limit` 取最近 limit 条（仍按时间正序返回）。已软删的线程返回空数组。 */
export function readMessages(repositoryPath: string, threadId: string, limit?: number): ChatThreadMessage[] {
  const rows = withDatabase(repositoryPath, (database) => database.chats.messages(threadId, limit));
  return rows.map(messageOf);
}

/** 改名：标题去空后截 120 字；空标题或线程不存在/已删返回 `undefined`（路由据此回 400/404）。 */
export function renameThread(repositoryPath: string, threadId: string, title: string): ChatThread | undefined {
  const trimmed = title.trim().slice(0, TITLE_MAX);
  if (!trimmed) return undefined;
  const row = withDatabase(repositoryPath, (database) => {
    const changed = database.chats.renameSession(threadId, trimmed, new Date().toISOString());
    return changed ? database.chats.session(threadId) : undefined;
  });
  return row && !row.deleted_at ? threadOf(row) : undefined;
}

/** 软删：返回是否真的删掉了一条未删线程（重复删第二次返回 false，供路由回 404）。 */
export function softDeleteThread(repositoryPath: string, threadId: string): boolean {
  return withDatabase(repositoryPath, (database) => database.chats.softDelete(threadId, new Date().toISOString())) > 0;
}

/** 机检与脚本用：正文行数，走未过滤的计数，所以软删线程的行仍然数得到——用来证明「删除没动原文」。 */
export function countMessagesRaw(repositoryPath: string, threadId: string): number {
  return withDatabase(repositoryPath, (database) => database.chats.countMessages(threadId));
}
