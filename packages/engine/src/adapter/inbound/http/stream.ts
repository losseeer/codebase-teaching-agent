import type { FastifyReply, FastifyRequest } from "fastify";
import type { ScopedStreamFrame, ServerEvent, TurnScene } from "@codebase-tutor/contract";

import { Journal } from "../../outbound/persistence/journal.js";
import { subscribeEvents, unsubscribeEvents } from "../../../events.js";
import { beginTurn, type TurnHandle } from "../../../application/runtime/turn-registry.js";
import { recordUnfinishedTurn, toolLoopAuditsOf } from "../../../application/runtime/turn-audit.js";

/** SSE 传输层：写帧、开连接、心跳与中止收尾。两条流的词表都在 shared：`ServerEvent` 与 `ScopedStreamFrame`。 */

/** 事件流心跳间隔：必须小于常见反向代理的空闲超时。 */
const EVENT_STREAM_PING_MS = 25_000;

/** SSE 单帧写出：客户端硬断时 `writableEnded` 仍为 false，故同时判 `destroyed`。 */
function sseFrame(reply: FastifyReply, frame: string): void {
  if (reply.raw.writableEnded || reply.raw.destroyed) return;
  reply.raw.write(frame);
}

function sseWriter<TFrame>(reply: FastifyReply): (event: TFrame) => void {
  return (event) => sseFrame(reply, `data: ${JSON.stringify(event)}\n\n`);
}

/** 建立 SSE：写头并立刻发一帧注释把响应头推到网路上；头里自带 CORS（`hijack()` 后不再经 cors 插件）。 */
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

/** 全局事件流的一条订阅：开局、心跳、断开摘除。 */
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

// s 标志让 `.` 匹配换行
function chunk(content: string, width: number): string[] { return content.match(new RegExp(`.{1,${width}}`, "gs")) ?? [content]; }

export function replayTypewriter(send: (event: ScopedStreamFrame) => void, text: string): void {
  for (const delta of chunk(text, TYPEWRITER_CHUNK)) send({ type: "delta", delta });
}

/** 开一轮作用域对话流：hijack → 首帧 → 登记回合；`dispose()` 要留在调用方的 finally。 */
export function beginScopedStream(request: FastifyRequest, reply: FastifyReply, scene: TurnScene, turnId: unknown): { send: (event: ScopedStreamFrame) => void; turnHandle: TurnHandle } {
  reply.hijack();
  return { send: openSseStream(request, reply), turnHandle: beginTurn(turnId, scene) };
}

/** 回合失败收尾：先判中止再判出错；中止写 `turn_aborted`，不写正文。 */
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
