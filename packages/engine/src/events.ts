import type { ServerEvent } from "@codebase-tutor/shared";
import { traceEngine } from "./trace/engine-log.js";

/**
  领域事件总线：没有请求边界的推送（导入进度、产物更新、画布改动）。
  它单独一层是因为**生产者不是 HTTP**：`application/canvas-tools.ts` 里那两条写路径（agent 改图、
  人工修正落盘）要发事件，而它们不该认识 `http/sse.ts`——「谁连着」是传输细节。
  传输层反过来订阅这里（`http/sse.ts` 注册 sink），方向只有一条：http → events。

  ⚠️ 帧**不按归属过滤**：认证闸撤了之后没有「谁的名单」这个东西可过滤（§64）。
  载荷里带着目标仓的绝对路径与改动文件名，所以这条长连接的可见面等于本机的可见面。
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

/** 当前订阅数（`GET /api/health` 与排障用的读数，不是判据）。 */
export function subscriptionCount(): number {
  return subscriptions.size;
}

/**
  广播：某一路订阅者写不进去（它的连接刚被中止）是它自己那一路的事，摘掉就好。
  这里必须兜住异常——`broadcast` 挂在 `importer.emit("event")` 的**同步链**上，
  一路死订阅者抛出的 write 异常会一路冒到 `ImportService.run` 的 catch，把一次已经算完的导入判成 failed。
  删除正在迭代的 Map 条目是安全的（已访问的不动、未访问的跳过）。
  */
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
