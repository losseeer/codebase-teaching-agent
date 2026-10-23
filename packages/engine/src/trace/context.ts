import { AsyncLocalStorage } from "node:async_hooks";

/**
  请求级 traceId 上下文：`llm/call-log.ts` 与 `store/journal.ts` 在很深的调用栈里落记录，
  从这里读 traceId，不用把参数穿进 server → turn → tool-loop → provider 四五层签名。

  传播方式：在 `onRequest` 里 `run(traceId, done)`。Fastify 的钩子链同步串联，`done()` 会同步调用
  下一个钩子/handler，所以在 `run` 回调内调用 `done()` 后续钩子与 handler 才继承该 store；
  先 `done()` 再 `run()`、或在 handler 里设值，store 都传不下去。

  后台任务分两种读数，别当成一个：
  - **导入**由 `POST /api/imports` 排队，`.then` 回调继承挂上去那一刻的上下文 → 它那几分钟里的 journal / llm.log
    行都带着这个 reqId。这是「这一次导入花了哪些钱」唯一的关联键，所以刻意不断开（reqId 对应的请求早已结束，
    读轨迹时按「活动的来源请求」理解，不是「请求还没跑完」）。
  - **监听器叫醒的重分析**没有请求上下文 → `currentTraceId()` 返回 null，靠 detail 里的 `repositoryId` / `job` 认。
  */

interface TraceContext {
  traceId: string;
  /**
    本轮所属的会话线程 id（教学侧 = sessionId）。放上下文而不是穿参数与 traceId 同一理由、同一传播机制：
    路由在确定线程后 markThread() 就地标注，深层只读不写。
    */
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

/** 当前请求的会话线程 id；未标注（后台任务、单次提问、无 LLM 的路径）时为 null。 */
export function currentThreadId(): string | null {
  return storage.getStore()?.threadId ?? null;
}

