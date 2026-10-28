/**
  HTTP 装配：Fastify 实例、CORS、请求钩子（trace / 来源闸 / 懒挂载）、事件桥与 controller 注册。
  监听、开机读数与收尾属进程生命周期，在 `infrastructure/bootstrap.ts`。
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
    // traceId 即 reqId，pino 请求行、trace 事件、llm.log 与 journal 共用
    genReqId: () => id(),
    logger: { level: process.env.LOG_LEVEL ?? "warn" }
  });
  // CORS 先于来源闸注册：钩子按注册顺序跑，403 的响应也要带 access-control-allow-origin
  await app.register(cors, { origin: (origin, callback) => callback(null, Boolean(origin && isTrustedOrigin(origin))) });
  tboot("cors registered");
  // 请求级 trace 上下文：后续钩子与 handler 继承该 store
  app.addHook("onRequest", (request, _reply, done) => { runWithTrace(request.id, done); });

  /** 来源闸：不可信的 `Origin` 当场 403，handler 一行都不执行。 */
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

  /** 懒挂载钩子：`/api/repositories/:repositoryId/*` 的请求先确保该仓已挂进内存；失败回 404 + `reason`。 */
  app.addHook("preHandler", async (request, reply) => {
    const repositoryId = (request.params as { repositoryId?: unknown })?.repositoryId;
    if (typeof repositoryId !== "string" || !repositoryId) return;
    if (request.method === "DELETE" && request.routeOptions?.url === "/api/repositories/:repositoryId") return;
    const result = importer.ensureMounted(repositoryId);
    if (result.ok) return;
    return reply.code(404).send({ error: result.message, reason: result.reason });
  });

  // 事件桥：仓库侧事件广播给 /api/events
  importer.on("event", broadcast);

  // 路由按面分组注册
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
