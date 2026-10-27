import type { FastifyReply, FastifyRequest } from "fastify";
import type { ScopedStreamFrame, ServerEvent, TurnScene } from "@codebase-tutor/contract";

import { Journal } from "../../../persistence/journal.js";
import { subscribeEvents, unsubscribeEvents } from "../../../events.js";
import { beginTurn, type TurnHandle } from "../../../application/turn-registry.js";
import { recordUnfinishedTurn, toolLoopAuditsOf } from "../../../application/turn-audit.js";

/**
  SSE 传输层：帧怎么写、连接怎么开、心跳与中止怎么收尾。
  两条流各有各的词表，都是 shared 里的闭合联合：未登记的帧编译不通过：
  - 全局事件流 `ServerEvent`：没有请求边界的推送（订阅表在 `events.ts`，这里只管连）；
  - 作用域对话流 `ScopedStreamFrame`：三条对话流各自请求的响应流，事件按请求隔离、断开自动清理。
*/

/** 事件流心跳间隔：必须小于常见反向代理的空闲超时。 */
const EVENT_STREAM_PING_MS = 25_000;

/** SSE 单帧写出（所有出口共用一条判据）：客户端硬断时 `writableEnded` 仍是 false，所以要连 `destroyed` 一起判。 */
function sseFrame(reply: FastifyReply, frame: string): void {
  if (reply.raw.writableEnded || reply.raw.destroyed) return;
  reply.raw.write(frame);
}

function sseWriter<TFrame>(reply: FastifyReply): (event: TFrame) => void {
  return (event) => sseFrame(reply, `data: ${JSON.stringify(event)}\n\n`);
}

/**
  建立 SSE：写头 + 立刻发一帧注释把响应头推到网路上。只调 `writeHead` 时 Node 把头部留在缓冲区，
  客户端要等到第一个 `data:` 帧才拿到响应，而中间层的空闲超时会中止这种「有连接、零字节」的上游。
  `:` 开头在 SSE 规范里是注释，任何解析器都跳过；读流循环只认 `data: ` 行，所以这一帧不带语义。
  头里必须自己带 CORS：`hijack()` 之后响应不再经 `@fastify/cors` 收尾，跨来源部署的浏览器一帧都读不到。
  */
export function openSseStream<TFrame = ScopedStreamFrame>(request: FastifyRequest, reply: FastifyReply): (event: TFrame) => void {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {})
  });
  sseFrame(reply, ": open\n\n");
  return sseWriter<TFrame>(reply);
}

/**
  全局事件流的一条订阅：开局（含 `hijack` 与首帧）→ 心跳 → 断开摘除，全在这里，路由只剩一行。
  断线重连与空闲超时由前端 `subscribeServerEvents` 管（fetch 读流才掐得住）；
  注释帧既顶住中间层的空闲超时，也让客户端在下一次广播之前从写入失败里察觉连接已死。
  */
export function openEventStream(request: FastifyRequest, reply: FastifyReply): void {
  reply.hijack();
  const connectionId = String(request.id);
  subscribeEvents({ connectionId, send: openSseStream<ServerEvent>(request, reply) });
  const ping = setInterval(() => {
    sseFrame(reply, ": ping\n\n");
  }, EVENT_STREAM_PING_MS);
  reply.raw.on("close", () => {
    clearInterval(ping);
    unsubscribeEvents(connectionId);
  });
}

/** 打字机回放的块长，三作用域共用。 */
const TYPEWRITER_CHUNK = 72;

// s 标志：`.` 默认不匹配换行，少了它回放会把多行回复的 `\n` 丢掉
function chunk(content: string, width: number): string[] { return content.match(new RegExp(`.{1,${width}}`, "gs")) ?? [content]; }

export function replayTypewriter(send: (event: ScopedStreamFrame) => void, text: string): void {
  for (const delta of chunk(text, TYPEWRITER_CHUNK)) send({ type: "delta", delta });
}

/**
  开一轮作用域对话流：hijack → 首帧落网 → 登记回合，三处顺序一致。
  `dispose()` 必须留在调用方的 finally 里，否则回合登记表里留一个永不摘除的在途条目，「停止生成」掐不到它。
*/
export function beginScopedStream(request: FastifyRequest, reply: FastifyReply, scene: TurnScene, turnId: unknown): { send: (event: ScopedStreamFrame) => void; turnHandle: TurnHandle } {
  reply.hijack();
  return { send: openSseStream(request, reply), turnHandle: beginTurn(turnId, scene) };
}

/**
  回合失败的收尾（三作用域同一口径）：先判中止再判出错——只有中止带着登记过的 turnId。
  用户点了停止就按「作废」收：journal 留一条 `turn_aborted`，不伪造正文也不写 `turn_text`。
*/
export function failScopedTurn(input: {
  send: (event: ScopedStreamFrame) => void;
  repositoryPath: string;
  repositoryId: string;
  scene: TurnScene;
  turnHandle: TurnHandle;
  provider: string;
  threadId?: string;
  error: unknown;
  fallbackError: string;
}): void {
  const aborted = Boolean(input.turnHandle.signal?.aborted);
  recordUnfinishedTurn({ repositoryPath: input.repositoryPath, repositoryId: input.repositoryId, scene: input.scene, provider: input.provider, outcome: aborted ? "aborted" : "failed", ...(input.threadId ? { threadId: input.threadId } : {}), audits: toolLoopAuditsOf(input.error) });
  if (!aborted) {
    input.send({ type: "error", error: input.error instanceof Error ? input.error.message : input.fallbackError });
    return;
  }
  new Journal(input.repositoryPath, input.repositoryId).append("turn_aborted", { scene: input.scene, turn_id: input.turnHandle.turnId ?? "unregistered", aborted_by: "user_stop" }, input.threadId);
  input.send({ type: "aborted", scene: input.scene });
}
