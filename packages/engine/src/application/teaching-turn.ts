import type { TutorMessage, TutorSession } from "@codebase-tutor/shared";
import { importer } from "../services.js";
import { validateSettings } from "../tutor-settings/tutor-settings.js";
import { appendMessages, createThread, getThread, readMessages, readThreadState, saveThreadState, type NewMessage, type TeachingThreadState } from "../store/chat-store.js";

/**
  「接着聊」这一件事的读写口径：会话线程 → 内存里的 `TutorSession`，以及回合正文与状态快照的落库。
  放在应用层而不是路由文件里，是因为三条作用域的对话流、会话列表、删除线程都要用同一份装配规则——
  两处各装一遍就会有一处多带字段、另一处少带（少带的那处表现为「重启后回到同一个会话却丢了设置」）。

  09-27 起真源是 `chat_session` / `chat_message` 两张表，journal 重放（旧 `harness/restore.ts`）退役：
  审计线继续按自己的口径记截断摘要，但「接着聊」不该依赖审计摘要的 2000 字截断。
  */

/**
  按 sessionId 从**该仓的 chat_session / chat_message** 装配回内存。
  以前这里还挂一个 `Map<sessionId, TutorSession>` 当在途缓存，但库里那份才是真源——缓存会说话：
  回合收尾写了快照、缓存里却是上一轮的设置，这类「读得到但不对」的坑踩过一次，
  2026-10-18 架构复审把它记成该删的全局态。装配一次是几条 SELECT，相对一趟 LLM 可以忽略。

  缺最低证据（线程不在、已软删、或状态快照字段不齐）就返回 undefined——
  调用方照旧 404/400 让 GUI 走新建，绝不编造半截会话。
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
  const thread = getThread(repositoryPath, sessionId);
  if (!thread || thread.repositoryId !== repositoryId || thread.scope !== "teach" || !thread.courseNodeId) return undefined;
  const state = readThreadState(repositoryPath, sessionId);
  if (!state) return undefined;
  const settings = validateSettings(state.settings);
  return {
    id: thread.id,
    repositoryId: thread.repositoryId,
    courseNodeId: thread.courseNodeId,
    style: settings.style,
    settings,
    messages: readMessages(repositoryPath, sessionId) as TutorMessage[],
    createdAt: thread.createdAt
  };
}

/**
  教学回合落库：正文（user + assistant 全文，不截断）+ 回合结束后的状态快照。
  线程行不在就按同一个 id 补建再写——回合正文是产品数据，丢了比多一行严重得多；
  反过来如果静默跳过写入，GUI 重启后就会看到「聊过但没记录」的空会话。
  */
export function persistTeachingTurn(repositoryPath: string, repositoryId: string, courseNodeId: string, title: string, sessionId: string, messages: NewMessage[], state: TeachingThreadState): void {
  if (!appendMessages(repositoryPath, sessionId, messages)) {
    createThread({ repositoryPath, repositoryId, scope: "teach", id: sessionId, courseNodeId, title });
    appendMessages(repositoryPath, sessionId, messages);
  }
  saveThreadState(repositoryPath, sessionId, state);
}
