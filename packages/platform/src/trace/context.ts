import { AsyncLocalStorage } from "node:async_hooks";

/**
  请求级 traceId/threadId 上下文：深调用栈直接读取，不穿参数。
  Fastify 钩子在 onRequest 里 `run(traceId, done)` 同步串联传播。
  导入任务继承排队时的上下文；监听器重分析无请求上下文（null）。
  */

interface TraceContext {
  traceId: string;
  /** 会话线程 id（教学侧 = sessionId）；路由 markThread 标注，深层只读。 */
  threadId?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** 在指定 traceId 的上下文里执行 `fn`（同步串联 Fastify 钩子时传 `done`）。 */
export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return storage.run({ traceId }, fn);
}

/** 当前请求的 traceId；不在请求上下文（后台任务 / 测试）时为 null。 */
export function currentTraceId(): string | null {
  return storage.getStore()?.traceId ?? null;
}

/** 标注本轮所属会话线程（路由解析出线程之后调用；后台任务没有线程可标）。 */
export function markThread(threadId: string | undefined): void {
  const store = storage.getStore();
  if (store && threadId) store.threadId = threadId;
}

/** 当前请求的会话线程 id；未标注时为 null。 */
export function currentThreadId(): string | null {
  return storage.getStore()?.threadId ?? null;
}

