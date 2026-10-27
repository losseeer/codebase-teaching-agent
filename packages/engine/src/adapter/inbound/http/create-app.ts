/**
  HTTP 装配：Fastify 实例、CORS、三道请求钩子（trace / 来源闸 / 懒挂载）、事件桥、八个 controller 的注册。
  不含监听、不含开机读数、不含收尾——那些是进程生命周期，住 `infrastructure/bootstrap.ts`，由入口文件 `server.ts` 挂上来。
  分组判据之一是会不会花钱：`repository-read` 一组一行模型请求都不发，付费的几组把闸门口径写在各自文件头。
*/
import Fastify from "fastify";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

import { id, runWithTrace, traceEngine } from "@codebase-tutor/platform";
import { tboot } from "../../../boot.js";
import { broadcast } from "../../../events.js";
import { importer } from "../../../infrastructure/composition-root.js";
import { isTrustedOrigin } from "../../outbound/security/origins.js";
import { registerChatRoutes } from "./controllers/chat.controller.js";
import { registerDiagramRoutes } from "./controllers/diagrams.controller.js";
import { registerExerciseRoutes } from "./controllers/exercises.controller.js";
import { registerPlatformRoutes } from "./controllers/platform.controller.js";
import { registerRepositoryReadRoutes } from "./controllers/repository-read.controller.js";
import { registerSettingsRoutes } from "./controllers/settings.controller.js";
import { registerTeachingRoutes } from "./controllers/teaching.controller.js";
import { registerThreadRoutes } from "./controllers/threads.controller.js";

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // traceId 即 reqId：pino 的请求行、本进程记的 trace 事件、llm.log 与 journal 共享同一个 id
    genReqId: () => id(),
    logger: { level: process.env.LOG_LEVEL ?? "warn" }
  });
  // CORS 必须先于来源闸注册：钩子按注册顺序跑，被拦的响应（403）也要带 access-control-allow-origin，
  // 否则浏览器里只剩一句「网络错误」，用户读不到引擎给的中文原因。
  // 来源不反射任意值：只有可信来源才给 `access-control-allow-origin`（判据一处：`security/origins.ts`）。
  await app.register(cors, { origin: (origin, callback) => callback(null, Boolean(origin && isTrustedOrigin(origin))) });
  tboot("cors registered");
  // 请求级 trace 上下文：`run(id, done)` 让后续钩子与 handler 继承该 store（传播原理见 trace/context.ts）
  app.addHook("onRequest", (request, _reply, done) => { runWithTrace(request.id, done); });

  /**
    来源闸：不可信的 `Origin` 当场 403，handler 一行都不执行。
    光靠 CORS 不给回头只挡住「浏览器读到响应」，服务端副作用照样发生；这一道把它挪到执行之前。
    预检交给 CORS 插件——非可信来源拿不到回头的预检响应，实际请求到不了这儿。
    ⚠️ 不豁免 `/api/health`：健康读数里有服务商、模型名与沙箱闸门状态，不给任意网页白拿。
    这一道只管「浏览器里哪个页面能碰这台引擎」，本机进程不在它的管辖范围内（没有认证闸）。
    */
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || request.method === "OPTIONS" || isTrustedOrigin(origin)) return;
    return reply.code(403).send({ error: `来源「${origin}」不在可信清单里：引擎默认只服务本机浏览器（回环来源）。跨来源部署请把该来源写进 TUTOR_ALLOWED_ORIGINS。`, reason: "origin_not_trusted" });
  });

  app.addHook("onResponse", (request, reply, done) => {
    traceEngine("http", { method: request.method, url: request.url, status: reply.statusCode }, { traceId: request.id, durationMs: Math.round(reply.elapsedTime) });
    done();
  });
  tboot("Fastify constructed");

  /**
    懒挂载钩子：`/api/repositories/:repositoryId/*` 的每个请求先确保该仓已挂进内存。
    boot 零 IO、零 watcher，地址簿里不活跃的仓完全不占资源，代价只是首次访问某个仓的请求稍慢。
    挂载失败按原因回 404 + `reason`，GUI 据此分清「工作区确实失效（清掉）」与「目录挪走/产物不全（留着处置）」。
    任何一支都不触发重新分析——重跑是花钱动作，只由用户点头。
    唯一豁免是移出地址簿那条 DELETE：它要处理的恰恰是挂不起来的仓，钩子先拦它用户就被锁在自己的地址簿外面。
    */
  app.addHook("preHandler", async (request, reply) => {
    const repositoryId = (request.params as { repositoryId?: unknown })?.repositoryId;
    if (typeof repositoryId !== "string" || !repositoryId) return;
    if (request.method === "DELETE" && request.routeOptions?.url === "/api/repositories/:repositoryId") return;
    const result = importer.ensureMounted(repositoryId);
    if (result.ok) return;
    return reply.code(404).send({ error: result.message, reason: result.reason });
  });

  // 事件桥：仓库侧的挂载/导入/失效事件要能广播到 GUI 的 `/api/events`（订阅表在 events.ts）
  importer.on("event", broadcast);

  // 路由按面分组住在这里，这里只做注册（顺序不影响匹配——各组路径互不重叠）
  registerPlatformRoutes(app);
  registerSettingsRoutes(app);
  registerRepositoryReadRoutes(app);
  registerDiagramRoutes(app);
  registerExerciseRoutes(app);
  registerChatRoutes(app);
  registerTeachingRoutes(app);
  registerThreadRoutes(app);
  return app;
}
