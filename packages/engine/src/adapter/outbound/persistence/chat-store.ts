import type { ChatScope, ChatThread, ChatThreadMessage } from "@codebase-tutor/contract";
import type { NewMessage, TeachingThreadState } from "../../../application/port/chat-store.js";

import { id } from "@codebase-tutor/platform";
import { type ChatMessageRow, type ChatSessionRow } from "./chat-repository.js";
import { withDatabase } from "./database.js";

/** 会话持久化的唯一出入口：正文不截断，删除只打 `deleted_at`，仓库归属用 `repository_id`。
    每个函数经 `withDatabase` 自开自闭。 */

const TITLE_MAX = 120;

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

/** 标题截到 120 字；为空则落作用域占位名。 */
function normalizeTitle(title: string | undefined, scope: ChatScope): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed.slice(0, TITLE_MAX);
  return scope === "teach" ? "新的教学会话" : scope === "map" ? "新的宏观设计对话" : "新的练习对话";
}

// 传入 id 则沿用，否则现生成。
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

/** 线程头；已软删或未入库返回 `undefined`。 */
export function getThread(repositoryPath: string, threadId: string): ChatThread | undefined {
  const row = withDatabase(repositoryPath, (database) => database.chats.session(threadId));
  return row && !row.deleted_at ? threadOf(row) : undefined;
}

/** 会话列表，最近更新在前，只含已有正文的线程。 */
export function listThreads(repositoryPath: string, repositoryId: string, scope: ChatScope, limit = 100): ChatThread[] {
  const rows = withDatabase(repositoryPath, (database) => database.chats.sessions(repositoryId, scope, limit));
  return rows.map(threadOf);
}

/** 追加消息并续期 `updated_at`；线程不存在或已软删返回 `false`。 */
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

/** 读 `state_json`：只校验 `settings` 在场，缺失或形状不合返回 `undefined`。 */
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

/** 全量覆盖状态快照，不改 `updated_at`；已软删线程返回 `false`。 */
export function saveThreadState(repositoryPath: string, threadId: string, state: TeachingThreadState): boolean {
  return withDatabase(repositoryPath, (database) => {
    const row = database.chats.session(threadId);
    if (!row || row.deleted_at) return false;
    database.chats.saveState(threadId, JSON.stringify(state));
    return true;
  });
}

/** 全量或尾窗正文：`limit` 取最近 limit 条，按时间正序返回；已软删线程返回空数组。 */
export function readMessages(repositoryPath: string, threadId: string, limit?: number): ChatThreadMessage[] {
  const rows = withDatabase(repositoryPath, (database) => database.chats.messages(threadId, limit));
  return rows.map(messageOf);
}

/** 改名：标题去空后截 120 字；空标题或线程不存在/已删返回 `undefined`。 */
export function renameThread(repositoryPath: string, threadId: string, title: string): ChatThread | undefined {
  const trimmed = title.trim().slice(0, TITLE_MAX);
  if (!trimmed) return undefined;
  const row = withDatabase(repositoryPath, (database) => {
    const changed = database.chats.renameSession(threadId, trimmed, new Date().toISOString());
    return changed ? database.chats.session(threadId) : undefined;
  });
  return row && !row.deleted_at ? threadOf(row) : undefined;
}

/** 软删；重复删除返回 `false`。 */
export function softDeleteThread(repositoryPath: string, threadId: string): boolean {
  return withDatabase(repositoryPath, (database) => database.chats.softDelete(threadId, new Date().toISOString())) > 0;
}

/** 正文行数，不按软删过滤。 */
export function countMessagesRaw(repositoryPath: string, threadId: string): number {
  return withDatabase(repositoryPath, (database) => database.chats.countMessages(threadId));
}

/** 交出绑定这一库路径的会话读写口。 */
export function chatStoreFor(repositoryPath: string) {
  return {
    createThread: (input: Omit<Parameters<typeof createThread>[0], "repositoryPath">) => createThread({ ...input, repositoryPath }),
    getThread: (threadId: string) => getThread(repositoryPath, threadId),
    listThreads: (repositoryId: string, scope: ChatScope, limit?: number) => listThreads(repositoryPath, repositoryId, scope, limit),
    appendMessages: (threadId: string, messages: NewMessage[]) => appendMessages(repositoryPath, threadId, messages),
    readThreadState: (threadId: string) => readThreadState(repositoryPath, threadId),
    saveThreadState: (threadId: string, state: TeachingThreadState) => saveThreadState(repositoryPath, threadId, state),
    readMessages: (threadId: string, limit?: number) => readMessages(repositoryPath, threadId, limit),
    renameThread: (threadId: string, title: string) => renameThread(repositoryPath, threadId, title),
    softDeleteThread: (threadId: string) => softDeleteThread(repositoryPath, threadId)
  };
}
