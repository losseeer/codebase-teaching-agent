import type { TraceScalar } from "@codebase-tutor/shared/wire";
import type { UiJournalEventType } from "./events";
import { flushJournalQueue, queueJournalEvent } from "./transport";

/**
  唯一的 UI 事件发射入口：`emit(repositoryId, type, payload, { sessionId })`。
  repositoryId 显式传参、不做全局单例；缺失时打 warning 而不静默丢弃。
  */
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
  // 排在串行队列末尾：先补发积压、再发本条，顺序即 append 顺序
  void queueJournalEvent(post);
}

/** 网络恢复时补发积压事件（在 App 启动时注册一次即可）。 */
export function installJournalRetry(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => { void flushJournalQueue(); });
  void flushJournalQueue();
}
