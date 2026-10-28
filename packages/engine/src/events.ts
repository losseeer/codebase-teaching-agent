import type { ServerEvent } from "@codebase-tutor/contract";

import { traceEngine } from "@codebase-tutor/platform";

/**
  领域事件总线：没有请求边界的推送（导入进度、产物更新、画布改动）。
  方向只有一条：入站层 → events。
  载荷含目标仓绝对路径，这条长连接的可见面等于本机可见面。
  */

/** 一路订阅：`connectionId` 用请求 id，只为读数与排障（谁掉线了能查到是哪一路）。 */
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

/** 广播必须 catch 单路异常：它在同步链上，一路死订阅者会把已算完的导入判成 failed。 */
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
