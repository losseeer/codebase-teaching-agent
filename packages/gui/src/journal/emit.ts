import type { TraceScalar } from "@codebase-tutor/domain";

import type { UiJournalEventType } from "./events";
import { flushJournalQueue, queueJournalEvent } from "./transport";

/** 唯一的 UI 事件发射入口；repositoryId 缺失时打 warning，不静默丢弃。 */
export function emit(
  repositoryId: string | null | undefined,
  type: UiJournalEventType,
  payload: Record<string, TraceScalar> = {},
  options: { sessionId?: string } = {}
): void {
  if (!repositoryId) {
    console.warn(`[journal] 当前未挂载仓库，事件 ${type} 未记录`);
    return;
  }
  const post = { repositoryId, type, payload, ...(options.sessionId ? { sessionId: options.sessionId } : {}) };
  // 排串行队列末尾：先补积压再发本条
  void queueJournalEvent(post);
}

/** 网络恢复时补发积压事件。 */
export function installJournalRetry(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => { void flushJournalQueue(); });
  void flushJournalQueue();
}
