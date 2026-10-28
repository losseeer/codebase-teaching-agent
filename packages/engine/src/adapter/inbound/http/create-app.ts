/**
  HTTP 装配：Fastify 实例、CORS、请求钩子（trace / 来源闸 / 懒挂载）、事件桥与 controller 注册。
  本文件不监听端口；监听在 `server.ts`。
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
    genReqId: () => id(),
    logger: { level: process.env.LOG_LEVEL ?? "warn" }
  });
  // CORS 必须先于来源闸注册
  await app.register(cors, { origin: (origin, callback) => callback(null, Boolean(origin && isTrustedOrigin(origin))) });
  tboot("cors registered");
  app.addHook("onRequest", (request, _reply, done) => { runWithTrace(request.id, done); });

  /** 来源闸：`Origin` 不可信时回 403。 */
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

  /** 懒挂载钩子：带 `repositoryId` 的请求先确保该仓挂进内存，失败回 404。 */
  app.addHook("preHandler", async (request, reply) => {
    const repositoryId = (request.params as { repositoryId?: unknown })?.repositoryId;
    if (typeof repositoryId !== "string" || !repositoryId) return;
    if (request.method === "DELETE" && request.routeOptions?.url === "/api/repositories/:repositoryId") return;
    const result = importer.ensureMounted(repositoryId);
    if (result.ok) return;
    return reply.code(404).send({ error: result.message, reason: result.reason });
  });

  importer.on("event", broadcast);

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
