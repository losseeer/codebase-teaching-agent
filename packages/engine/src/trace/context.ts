import { AsyncLocalStorage } from "node:async_hooks";

/**
  请求级 traceId 上下文（trace context propagation）。

  为什么需要它：`llm/call-log.ts` 与 `store/journal.ts` 分别在很深的调用栈里落记录，
  如果逐层加参数，签名要改穿 server → harness → tool-loop → provider 四五层。
  AsyncLocalStorage 让这两处直接读到当前请求的 traceId，无需改签名。

  传播方式（关键，别改成别的写法）：在 `onRequest` 里 `run(traceId, done)`。
  Fastify 的钩子链是**同步串联**的——`done()` 会同步调用下一个钩子/handler，
  因此在 `run` 回调内调用 `done()` 能让后续钩子与 handler 继承该 store。
  ❌ 不要改用「先 done() 再 run()」或放在 handler 里设值：那样子进程已经创建、store 传不下去。

  后台任务（导入、fs 监听触发的重分析）不在任何请求上下文里 → `currentTraceId()` 返回 null，
  各自用自己的事件标识（如 `job:<jobId>`）写在 detail 里。
  */

interface TraceContext {
  traceId: string;
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
