import type { ChatThread } from "@codebase-tutor/contract";
import { repositoryOr404 } from "../../services.js";
import { createThread, getThread, isChatScope, listThreads, readMessages, renameThread, softDeleteThread } from "../../store/chat-store.js";
import { Journal } from "../../store/journal.js";
import { locateThread, threadJournalPayload } from "../threads.js";

/**
  会话线程的用例：清单、新建、读正文、改名、软删。
  用例只报结果，不报 HTTP——状态码与响应体形状是传输层的事，由 controller 一对一翻译过去。

  线程 id 一律由引擎发（`createThread` 里的 UUID），界面只持有与回传：
  凡是要进模型上下文的东西都得能在库里考据到，客户端临时拼的窗口正文不算。
  删除是软删：`chat_session` 打 `deleted_at`，`chat_message` 原文一行不动，journal 追加一条 `session_deleted`。
  */
export type ThreadsFailure = "repository-missing" | "scope-invalid" | "thread-missing" | "title-empty";

export type ThreadsResult<T> = { ok: true; value: T } | { ok: false; failure: ThreadsFailure };

const fail = (failure: ThreadsFailure): { ok: false; failure: ThreadsFailure } => ({ ok: false, failure });

/** 归属对象的长度上限：产物会重新分析，这里只截长不校验存在性（指针对象可能已经不在今天的索引里）。 */
const MAX_SCOPE_REF = 400;
const MAX_EXERCISE_ID = 200;

function mounted(repositoryId: string) {
  const repository = repositoryOr404(repositoryId);
  return repository ? { path: repository.path, repositoryId: repository.index.repositoryId } : undefined;
}

/**
  清单只收谈过的会话，所以「还没发言的新会话」不在里面。`current` 这一格让界面能区分
  「这条空会话还在」与「这条已被删掉/本来不属于这儿」——没有它，新建之后的任何一次刷新都会把刚建的那条当残留剪掉。
  */
export function listScopeThreads(repositoryId: string, scopeQuery: string | undefined, currentQuery: string | undefined): ThreadsResult<{ threads: ChatThread[]; current: ChatThread | null }> {
  const repository = mounted(repositoryId);
  if (!repository) return fail("repository-missing");
  const scope = isChatScope(scopeQuery) ? scopeQuery : undefined;
  if (!scope) return fail("scope-invalid");
  const asked = typeof currentQuery === "string" ? currentQuery : "";
  const found = asked ? getThread(repository.path, asked) : undefined;
  const current = found && found.repositoryId === repository.repositoryId && found.scope === scope ? found : null;
  return { ok: true, value: { threads: listThreads(repository.path, repository.repositoryId, scope), current } };
}

export function createThreadUseCase(repositoryId: string, input: { scope?: string; scopeRef?: string; exerciseId?: string; title?: string }): ThreadsResult<{ thread: ChatThread }> {
  const repository = mounted(repositoryId);
  if (!repository) return fail("repository-missing");
  const scope = isChatScope(input.scope) ? input.scope : undefined;
  if (!scope) return fail("scope-invalid");
  const scopeRef = input.scopeRef?.trim().slice(0, MAX_SCOPE_REF);
  const exerciseId = input.exerciseId?.trim().slice(0, MAX_EXERCISE_ID);
  const title = input.title;
  const thread = createThread({ repositoryPath: repository.path, repositoryId: repository.repositoryId, scope, ...(scopeRef ? { scopeRef } : {}), ...(exerciseId ? { exerciseId } : {}), ...(title ? { title } : {}) });
  new Journal(repository.path, repository.repositoryId).append("session_created", threadJournalPayload(thread, "created"), thread.id);
  return { ok: true, value: { thread } };
}

/** 线程正文（产品线）：界面刷新或引擎重启后按 threadId 取回对话展示。软删线程读不到——读侧恒带 `deleted_at IS NULL`。 */
export function readThreadMessages(threadId: string): ThreadsResult<{ thread: ChatThread; messages: ReturnType<typeof readMessages> }> {
  const located = locateThread(threadId);
  if (!located) return fail("thread-missing");
  return { ok: true, value: { thread: located.thread, messages: readMessages(located.repositoryPath, located.thread.id) } };
}

export function renameThreadUseCase(threadId: string, title: string | undefined): ThreadsResult<{ thread: ChatThread }> {
  const located = locateThread(threadId);
  if (!located) return fail("thread-missing");
  if (!title?.trim()) return fail("title-empty");
  const thread = renameThread(located.repositoryPath, located.thread.id, title);
  return thread ? { ok: true, value: { thread } } : fail("thread-missing");
}

/** 教学会话没有常驻内存态：按 sessionId 每次从这两张表现装配，所以这里没有要清的在途东西。 */
export function deleteThreadUseCase(threadId: string): ThreadsResult<{ threadId: string }> {
  const located = locateThread(threadId);
  if (!located || !softDeleteThread(located.repositoryPath, located.thread.id)) return fail("thread-missing");
  new Journal(located.repositoryPath, located.repositoryId).append("session_deleted", threadJournalPayload(located.thread, "user_deleted"), located.thread.id);
  return { ok: true, value: { threadId: located.thread.id } };
}
