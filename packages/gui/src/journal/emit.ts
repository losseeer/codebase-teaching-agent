import type { TraceScalar } from "@codebase-tutor/shared";
import type { UiJournalEventType } from "./events";
import { flushJournalQueue, postJournalEvent } from "./transport";

/**
  唯一的 UI 事件发射入口：`emit(repositoryId, type, payload, { sessionId })`。

  为什么 repositoryId 必须显式传（不做全局单例）：视图本来就各自持有 workspace，
  显式传参让「这条事件属于哪个仓库」在调用点一眼可见，也避免全局态在切仓库时错位。

  没有 repositoryId 时**不静默丢弃**：打一条 warning（缺事件的 UI 操作是设计漏洞，
  但「未挂载仓库」时确实无处可写，所以要说出来而不是假装发过）。
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
  // 有积压就先补发，再发新事件——顺序即 append 顺序
  void flushJournalQueue().then(() => postJournalEvent(post));
}

/** 网络恢复时补发积压事件（在 App 启动时注册一次即可）。 */
export function installJournalRetry(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => { void flushJournalQueue(); });
  void flushJournalQueue();
}
