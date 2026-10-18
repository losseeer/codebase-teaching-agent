import type { FastifyReply, FastifyRequest } from "fastify";
import type { ScopedStreamFrame, ServerEvent, TurnScene } from "@codebase-tutor/shared";
import { Journal } from "../store/journal.js";
import { traceEngine } from "../trace/engine-log.js";
import { beginTurn, type TurnHandle } from "../turns/registry.js";
import { recordAbortedAudits, toolLoopAuditsOf } from "../application/turn-audit.js";

/**
  SSE 传输层：帧怎么写、连接怎么开、心跳与中止怎么收尾。
  两条流各有各的词表（都是 shared 里的闭合联合，发一种没登记的帧编不过去）：
  - 全局事件流 `ServerEvent`：导入进度、产物更新这类「没有请求边界的推送」；
  - 作用域对话流 `ScopedStreamFrame`：三条对话流各自请求的响应流（事件天然按请求隔离，断开自动清理）。
*/

/**
  全局事件流的订阅者（`GET /api/events`）：导入进度这类「无请求边界的推送」走这里；对话回放走各自请求的 SSE 响应流。
  一路订阅连着它的**请求**一起存：来源闸只在连接进来那一次判，之后每一帧不再重判来源；
  帧里带着目标仓的绝对路径与改动文件名，所以这条流是本机可读的（认证闸与按人过滤已于 2026-10-15 撤除，§64）。
  */
const subscribers = new Set<{ send: (event: ServerEvent) => void; request: FastifyRequest }>();

/** 事件流心跳间隔：25s 卡在常见反向代理 60s 空闲超时之内，又是浏览器完全无感的一档。 */
const EVENT_STREAM_PING_MS = 25_000;

/**
  广播：某一路订阅者写不进去（它的连接刚被中止）是它自己那一路的事，移除就好。
  这里必须兜住异常——`broadcast` 挂在 `importer.emit("event")` 的**同步链**上，
  一路死订阅者抛出的 write 异常会一路冒到 `ImportService.run` 的 catch，把一次已经算完的导入判成 failed。
  删除正在迭代的 Set 元素是安全的（已访问的不动、未访问的跳过）。
  ⚠️ 帧**不按归属过滤**：认证闸撤了之后没有「谁的名单」这个东西可过滤（§64）。
  载荷里带着目标仓的绝对路径与改动文件名，所以这条长连接的可见面等于本机的可见面。
  */
export function broadcast(event: ServerEvent): void {
  for (const client of subscribers) {
    try {
      client.send(event);
    } catch {
      subscribers.delete(client);
      traceEngine("degrade", { what: "sse_subscriber_dropped" });
    }
  }
}

/**
  SSE 单帧写出（四处出口共用的一条判据）。
  判 `destroyed` 不只看 `writableEnded`：客户端硬断（关页面、切走）时 `writableEnded` 仍是 false，
  这时 write 会抛——四条出口是一条判据，分开写迟早只改一处（10-06 复审就是这么发现广播会崩导入的）。
  */
function sseFrame(reply: FastifyReply, frame: string): void {
  if (reply.raw.writableEnded || reply.raw.destroyed) return;
  reply.raw.write(frame);
}

function sseWriter<TFrame>(reply: FastifyReply): (event: TFrame) => void {
  return (event) => sseFrame(reply, `data: ${JSON.stringify(event)}\n\n`);
}

/**
  建立 SSE：写头 + **立刻发一帧注释把响应头推到网路上**。
  只调 `writeHead` 时 Node 把头部留在缓冲区，客户端要等到第一个 `data:` 帧才拿得到响应。
  10-12 实测：空转的 `/api/events` 三秒收到 0 字节——本机直连只是「看起来连着」，
  而共享部署那层反向代理（nginx 默认 `proxy_read_timeout` 60s）会把这种「有连接、零字节」的上游直接中止，
  界面就退回「导入进度停在 0%，任务其实跑完了」那一档。
  `:` 开头在 SSE 规范里是注释，任何解析器都跳过；读流循环只认 `data: ` 行，所以这一帧不带语义。

  头里还必须自己带上 CORS：`hijack()` 之后响应不再经 `@fastify/cors` 收尾，
  跨来源部署的浏览器一帧都读不到（与 §47 那个钩子顺序是同一类事故）。
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
  断线重连与「空闲超时只掐这一条连接」由前端 `subscribeServerEvents` 自己管
  （fetch 读流才掐得住，见 §47）；注释帧既顶住中间层的空闲超时，也让客户端在下一次广播之前
  就从写入失败里察觉连接已死。
  */
export function openEventStream(request: FastifyRequest, reply: FastifyReply): void {
  reply.hijack();
  const client = { send: openSseStream<ServerEvent>(request, reply), request };
  subscribers.add(client);
  const ping = setInterval(() => {
    sseFrame(reply, ": ping\n\n");
  }, EVENT_STREAM_PING_MS);
  reply.raw.on("close", () => {
    clearInterval(ping);
    subscribers.delete(client);
  });
}

/** 打字机回放的块长：三作用域同款，改一处就全改（真 token 流式要 provider 层改造，这里先消除「整段落下」）。 */
const TYPEWRITER_CHUNK = 72;

// s 标志：`.` 默认不匹配换行，回放会把多行回复的 `\n` 全丢掉（打字机预览塌成一行）；加上后逐块保留换行
function chunk(content: string, width: number): string[] { return content.match(new RegExp(`.{1,${width}}`, "gs")) ?? [content]; }

export function replayTypewriter(send: (event: ScopedStreamFrame) => void, text: string): void {
  for (const delta of chunk(text, TYPEWRITER_CHUNK)) send({ type: "delta", delta });
}

/**
  开一轮作用域对话流：hijack → 首帧落网 → 登记回合。三处顺序一致，且 `dispose()` 必须留在调用方的 finally 里——
  漏一处就是往回合登记表里塞一个永不摘除的在途条目，之后「停止生成」按名字也掐不到它。
*/
export function beginScopedStream(request: FastifyRequest, reply: FastifyReply, scene: TurnScene, turnId: unknown): { send: (event: ScopedStreamFrame) => void; turnHandle: TurnHandle } {
  reply.hijack();
  return { send: openSseStream(request, reply), turnHandle: beginTurn(turnId, scene) };
}

/**
  回合失败的收尾（三作用域同一口径）：中止与出错是两件事，先判中止——只有它带着登记过的 turnId，
  出错分支什么都不知道。用户点了停止就按「作废」收：journal 留一条 `turn_aborted`、不伪造正文也不写 `turn_text`。
*/
export function failScopedTurn(input: {
  send: (event: ScopedStreamFrame) => void;
  repositoryPath: string;
  repositoryId: string;
  scene: TurnScene;
  turnHandle: TurnHandle;
  threadId?: string;
  error: unknown;
  fallbackError: string;
}): void {
  if (!input.turnHandle.signal?.aborted) {
    input.send({ type: "error", error: input.error instanceof Error ? input.error.message : input.fallbackError });
    return;
  }
  recordAbortedAudits({ repositoryPath: input.repositoryPath, repositoryId: input.repositoryId, scene: input.scene, ...(input.threadId ? { threadId: input.threadId } : {}), audits: toolLoopAuditsOf(input.error) });
  new Journal(input.repositoryPath, input.repositoryId).append("turn_aborted", { scene: input.scene, turn_id: input.turnHandle.turnId ?? "unregistered", aborted_by: "user_stop" }, input.threadId);
  input.send({ type: "aborted", scene: input.scene });
}
