import type { ServerEvent } from "@codebase-tutor/contract";

import { traceEngine } from "@codebase-tutor/platform";

/**
  领域事件总线：没有请求边界的推送（导入进度、产物更新、画布改动）。
  方向只有一条：入站层 → events。
  */

/** 一路订阅；`connectionId` 取请求 id。 */
export interface EventSubscription {
  connectionId: string;
  send: (event: ServerEvent) => void;
}

const subscriptions = new Map<string, EventSubscription>();

export function subscribeEvents(subscription: EventSubscription): void {
  subscriptions.set(subscription.connectionId, subscription);
}

export function unsubscribeEvents(connectionId: string): void {
  subscriptions.delete(connectionId);
}

/** 广播在同步链上，需 catch 单路订阅者异常。 */
export function broadcast(event: ServerEvent): void {
  for (const [connectionId, subscription] of subscriptions) {
    try {
      subscription.send(event);
    } catch {
      subscriptions.delete(connectionId);
      traceEngine("degrade", { what: "sse_subscriber_dropped", connection_id: connectionId });
    }
  }
}
