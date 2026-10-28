import type { TutorMessage, TutorSession } from "@codebase-tutor/domain";
import { validateSettings } from "@codebase-tutor/domain";

import { importer } from "../../infrastructure/composition-root.js";
import { traceEngine } from "@codebase-tutor/platform";
import type { ChatStore, NewMessage, TeachingThreadState } from "../port/chat-store.js";

/**
  教学会话线程 ↔ 内存 `TutorSession` 的读写口径，以及回合正文与状态快照的落库。
  真源是 `chat_session` / `chat_message` 两张表。
*/

/** 按 sessionId 在已挂载的仓里装配内存会话；证据不齐返回 `undefined`。 */
export function resolveTeachingState(sessionId: string): TutorSession | undefined {
  for (const repository of importer.mountedRepositories()) {
    const restored = restoreThreadAsSession(repository.path, repository.index.repositoryId, sessionId);
    if (restored) return restored;
  }
  return undefined;
}

/** 教学线程 → `TutorSession`：正文取原文，状态取落库快照；任一缺失返回 `undefined`。 */
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

/** 教学回合落库：正文全文 + 回合结束后的状态快照；线程行不在就按同一个 id 补建再写。 */
export function persistTeachingTurn(store: ChatStore, repositoryId: string, scopeRef: string, title: string, sessionId: string, messages: NewMessage[], state: TeachingThreadState): void {
  if (!store.appendMessages(sessionId, messages)) {
    store.createThread({ repositoryId, scope: "teach", id: sessionId, scopeRef, title });
    if (!store.appendMessages(sessionId, messages)) {
      traceEngine("degrade", { component: "teaching_turn", action: "persist", cause: `线程补建后正文仍写不进（session ${sessionId}）` });
    }
  }
  store.saveThreadState(sessionId, state);
}
