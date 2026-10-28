import { isChatScope, type ChatThread, type ChatThreadMessage } from "@codebase-tutor/contract";
import { importer, repositoryOr404 } from "../../infrastructure/composition-root.js";
import { locateThread, threadJournalPayload } from "../orchestration/threads.js";

/**
  会话线程的用例：清单、新建、读正文、改名、软删；状态码与响应形状在传输层。
  线程 id 由引擎生成，界面只持有与回传。
  删除是软删：`chat_session` 打 `deleted_at`，`chat_message` 原文不动，journal 追加 `session_deleted`。
*/
export type ThreadsFailure = "repository-missing" | "scope-invalid" | "thread-missing" | "title-empty";

export type ThreadsResult<T> = { ok: true; value: T } | { ok: false; failure: ThreadsFailure };

const fail = (failure: ThreadsFailure): { ok: false; failure: ThreadsFailure } => ({ ok: false, failure });

/** scopeRef 与 exerciseId 的长度上限：只截长，不校验存在性。 */
const MAX_SCOPE_REF = 400;
const MAX_EXERCISE_ID = 200;

function mounted(repositoryId: string) {
  const repository = repositoryOr404(repositoryId);
  return repository ? { path: repository.path, repositoryId: repository.index.repositoryId, audit: repository.audit, chatStore: repository.chatStore } : undefined;
}

/** 清单只收有正文的会话；`current` 单列那条还没发言的新会话。 */
export function listScopeThreads(repositoryId: string, scopeQuery: string | undefined, currentQuery: string | undefined): ThreadsResult<{ threads: ChatThread[]; current: ChatThread | null }> {
  const repository = mounted(repositoryId);
  if (!repository) return fail("repository-missing");
  const scope = isChatScope(scopeQuery) ? scopeQuery : undefined;
  if (!scope) return fail("scope-invalid");
  const asked = typeof currentQuery === "string" ? currentQuery : "";
  const found = asked ? repository.chatStore.getThread(asked) : undefined;
  const current = found && found.repositoryId === repository.repositoryId && found.scope === scope ? found : null;
  return { ok: true, value: { threads: repository.chatStore.listThreads(repository.repositoryId, scope), current } };
}

export function createThreadUseCase(repositoryId: string, input: { scope?: string; scopeRef?: string; exerciseId?: string; title?: string }): ThreadsResult<{ thread: ChatThread }> {
  const repository = mounted(repositoryId);
  if (!repository) return fail("repository-missing");
  const scope = isChatScope(input.scope) ? input.scope : undefined;
  if (!scope) return fail("scope-invalid");
  const scopeRef = input.scopeRef?.trim().slice(0, MAX_SCOPE_REF);
  const exerciseId = input.exerciseId?.trim().slice(0, MAX_EXERCISE_ID);
  const title = input.title;
  const thread = repository.chatStore.createThread({ repositoryId: repository.repositoryId, scope, ...(scopeRef ? { scopeRef } : {}), ...(exerciseId ? { exerciseId } : {}), ...(title ? { title } : {}) });
  repository.audit.append("session_created", threadJournalPayload(thread, "created"), thread.id);
  return { ok: true, value: { thread } };
}

/** 按 threadId 取线程与正文；已软删的读不到。 */
export function readThreadMessages(threadId: string): ThreadsResult<{ thread: ChatThread; messages: ChatThreadMessage[] }> {
  const located = locateThread(threadId);
  if (!located) return fail("thread-missing");
  return { ok: true, value: { thread: located.thread, messages: importer.chatStore(located.repositoryPath).readMessages(located.thread.id) } };
}

export function renameThreadUseCase(threadId: string, title: string | undefined): ThreadsResult<{ thread: ChatThread }> {
  const located = locateThread(threadId);
  if (!located) return fail("thread-missing");
  if (!title?.trim()) return fail("title-empty");
  const thread = importer.chatStore(located.repositoryPath).renameThread(located.thread.id, title);
  return thread ? { ok: true, value: { thread } } : fail("thread-missing");
}

/** 软删线程并记 `session_deleted`；会话无常驻内存态。 */
export function deleteThreadUseCase(threadId: string): ThreadsResult<{ threadId: string }> {
  const located = locateThread(threadId);
  if (!located || !importer.chatStore(located.repositoryPath).softDeleteThread(located.thread.id)) return fail("thread-missing");
  importer.audit(located.repositoryPath, located.repositoryId).append("session_deleted", threadJournalPayload(located.thread, "user_deleted"), located.thread.id);
  return { ok: true, value: { threadId: located.thread.id } };
}
