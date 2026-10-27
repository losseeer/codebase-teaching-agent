import type { TutorMessage, TutorSession } from "@codebase-tutor/domain";
import { validateSettings } from "@codebase-tutor/domain";

import { importer } from "../../infrastructure/composition-root.js";
import { traceEngine } from "@codebase-tutor/platform";
import type { ChatStore, NewMessage, TeachingThreadState } from "../port/chat-store.js";

/**
  「接着聊」的读写口径：会话线程 ↔ 内存里的 `TutorSession`，以及回合正文与状态快照的落库。
  放在应用层而不是路由文件里：三条作用域的对话流、会话列表、删除线程共用同一份装配规则。
  真源是 `chat_session` / `chat_message` 两张表；审计线按自己的口径记截断摘要，「接着聊」不依赖它。
*/

/**
  按 sessionId 从该仓的 `chat_session` / `chat_message` 装配回内存；库里那份是唯一真源，不设在途缓存。
  装配只是几条 SELECT，相对一趟 LLM 可忽略。
  缺最低证据（线程不在、已软删、状态快照字段不齐）返回 undefined——调用方照旧 404/400 走新建，不返回半截会话。
*/
export function resolveTeachingState(sessionId: string): TutorSession | undefined {
  for (const repository of importer.mountedRepositories()) {
    const restored = restoreThreadAsSession(repository.path, repository.index.repositoryId, sessionId);
    if (restored) return restored;
  }
  return undefined;
}

/** 教学线程 → TutorSession：正文取原文（不截断），状态取回合收尾写的快照。 */
export function restoreThreadAsSession(repositoryPath: string, repositoryId: string, sessionId: string): TutorSession | undefined {
  const store = importer.chatStore(repositoryPath);
  const thread = store.getThread(sessionId);
  if (!thread || thread.repositoryId !== repositoryId || thread.scope !== "teach" || !thread.scopeRef) return undefined;
  const state = store.readThreadState(sessionId);
  if (!state) return undefined;
  const settings = validateSettings(state.settings);
  return {
    id: thread.id,
    repositoryId: thread.repositoryId,
    scopeRef: thread.scopeRef,
    style: settings.style,
    settings,
    messages: store.readMessages(sessionId) as TutorMessage[],
    createdAt: thread.createdAt
  };
}

/**
  教学回合落库：正文（user + assistant 全文，不截断）+ 回合结束后的状态快照。
  线程行不在就按同一个 id 补建再写：正文是产品数据，不可恢复；静默跳过会让 GUI 重启后看到空会话。
*/
export function persistTeachingTurn(store: ChatStore, repositoryId: string, scopeRef: string, title: string, sessionId: string, messages: NewMessage[], state: TeachingThreadState): void {
  if (!store.appendMessages(sessionId, messages)) {
    store.createThread({ repositoryId, scope: "teach", id: sessionId, scopeRef, title });
    if (!store.appendMessages(sessionId, messages)) {
      // 补建线程之后还是写不进，这一轮正文就没了（GUI 重启看到的是空会话）。不可恢复的丢必须出声。
      traceEngine("degrade", { component: "teaching_turn", action: "persist", cause: `线程补建后正文仍写不进（session ${sessionId}）` });
    }
  }
  store.saveThreadState(sessionId, state);
}
