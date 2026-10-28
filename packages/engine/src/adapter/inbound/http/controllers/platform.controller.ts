import { openEventStream } from "../stream.js";
import { externalSurfaceUseCase } from "../../../../application/use-case/integrations.js";
import { healthUseCase, reprobeSandboxUseCase } from "../../../../application/use-case/health.js";
import { getImportJobUseCase, forgetRepositoryUseCase, listCatalogUseCase, mountRepositoryUseCase, setWatchingUseCase, submitImportUseCase, type RepositoryFailure } from "../../../../application/use-case/repositories.js";
import { ingestUiEventUseCase, type IngestFailure } from "../../../../application/use-case/journal-ingest.js";
import { REPOSITORY_NOT_MOUNTED } from "../../../../infrastructure/composition-root.js";
import type { FastifyInstance, FastifyReply } from "fastify";

/** 引擎运维面路由：地址簿、挂载与监听开关、外部能力面读数、健康与沙箱、事件流、导入任务、界面动作事件出口。 */
const rejectedRepo = (reply: FastifyReply, failure: RepositoryFailure): FastifyReply => {
  switch (failure.kind) {
    case "not-mounted": return reply.code(404).send({ error: failure.message, reason: failure.reason });
    case "import-rejected": return reply.code(400).send({ error: failure.message });
    case "job-missing": return reply.code(404).send({ error: "导入任务不存在" });
  }
};

const rejectedIngest = (reply: FastifyReply, failure: IngestFailure): FastifyReply => {
  switch (failure.kind) {
    case "repository-missing": return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
    case "engine-owned-event": return reply.code(400).send({ error: "这类事件由引擎在工具循环与装配里写，界面接口不收（同一事实只写一处）。", reason: "engine_owned_event" });
    case "unknown-event": return reply.code(400).send({ error: "事件类型不在 journal 契约内。", reason: "unknown_event" });
    case "payload-not-object": return reply.code(400).send({ error: "payload 必须是对象。" });
    case "payload-value-invalid": return reply.code(400).send({ error: `payload.${failure.key} 仅允许 string | number | boolean | null。` });
    case "payload-too-long": return reply.code(400).send({ error: `payload.${failure.key} 过长（上限 2000 字符）。` });
    case "session-id-invalid": return reply.code(400).send({ error: "sessionId 必须是不超过 200 字符的字符串。" });
  }
};

export function registerPlatformRoutes(app: FastifyInstance): void {
  app.get("/api/repositories", async () => listCatalogUseCase());

  app.get("/api/external", async () => externalSurfaceUseCase());

  app.post<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/mount", async (request, reply) => {
    const result = mountRepositoryUseCase(request.params.repositoryId);
    return result.ok ? result.value : rejectedRepo(reply, result.failure);
  });

  app.delete<{ Params: { repositoryId: string }; Querystring: { artifacts?: string } }>("/api/repositories/:repositoryId", async (request) => forgetRepositoryUseCase(request.params.repositoryId, request.query.artifacts === "1"));

  // 带 `:repositoryId` 的路由由懒挂载钩子先挂上，未挂载在该步已回 404
  app.post<{ Params: { repositoryId: string }; Body: { paused?: unknown; ttlMs?: unknown } }>("/api/repositories/:repositoryId/watch", async (request) => {
    const paused = request.body?.paused !== false;
    const ttlMs = typeof request.body?.ttlMs === "number" ? request.body.ttlMs : undefined;
    return setWatchingUseCase(request.params.repositoryId, paused, ttlMs);
  });

  app.post("/api/sandbox/reprobe", async () => reprobeSandboxUseCase());

  app.get("/api/health", async () => healthUseCase());

  app.get("/api/events", async (request, reply) => {
    openEventStream(request, reply);
  });

  app.post<{ Body: { path?: string; summaryHeaderComments?: boolean } }>("/api/imports", async (request, reply) => {
    const result = submitImportUseCase(request.body?.path ?? "", request.body?.summaryHeaderComments);
    return result.ok ? reply.code(202).send(result.value) : rejectedRepo(reply, result.failure);
  });

  app.get<{ Params: { jobId: string } }>("/api/imports/:jobId", async (request, reply) => {
    const result = getImportJobUseCase(request.params.jobId);
    return result.ok ? result.value : rejectedRepo(reply, result.failure);
  });

  app.post<{ Params: { repositoryId: string }; Body: { type?: unknown; payload?: unknown; sessionId?: unknown } }>("/api/repositories/:repositoryId/journal", async (request, reply) => {
    const result = ingestUiEventUseCase(request.params.repositoryId, request.body ?? {});
    return result.ok ? reply.code(201).send(result.value) : rejectedIngest(reply, result.failure);
  });
}
