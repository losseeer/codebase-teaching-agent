import {
  createTopicUseCase,
  deleteTopicUseCase,
  listTopicsUseCase,
  mergeTopicsUseCase,
  readCrossRepoLearningProfileUseCase,
  updateTopicUseCase,
  type LearnerFailure
} from "../../../../application/use-case/learner.js";
import type { FastifyInstance, FastifyReply } from "fastify";

/** 用户级学习状态：跨仓画像与主题 CRUD；这些路由不挂仓库。 */
function rejected(reply: FastifyReply, failure: LearnerFailure): FastifyReply {
  switch (failure.kind) {
    case "topic-missing": return reply.code(404).send({ error: "主题不存在" });
    case "topic-invalid": return reply.code(400).send({ error: "主题名称不能为空" });
    case "topic-merge-invalid": return reply.code(422).send({ error: "无法合并：源或目标主题不存在、已合并或已删除" });
  }
}

export function registerLearnerRoutes(app: FastifyInstance): void {
  app.get("/api/learner/profile", async () => readCrossRepoLearningProfileUseCase());

  app.get("/api/topics", async () => listTopicsUseCase());

  app.post<{ Body: { id?: unknown; label?: unknown; hint?: unknown } }>("/api/topics", async (request, reply) => {
    const result = createTopicUseCase(request.body ?? {});
    return result.ok ? reply.code(201).send({ topic: result.value }) : rejected(reply, result.failure);
  });

  app.patch<{ Params: { topicId: string }; Body: { label?: unknown; hint?: unknown } }>("/api/topics/:topicId", async (request, reply) => {
    const result = updateTopicUseCase(request.params.topicId, request.body ?? {});
    return result.ok ? reply.send({ topic: result.value }) : rejected(reply, result.failure);
  });

  app.delete<{ Params: { topicId: string } }>("/api/topics/:topicId", async (request, reply) => {
    const result = deleteTopicUseCase(request.params.topicId);
    return result.ok ? reply.send(result.value) : rejected(reply, result.failure);
  });

  app.post<{ Params: { topicId: string }; Body: { targetId?: unknown; into?: unknown } }>("/api/topics/:topicId/merge", async (request, reply) => {
    const target = typeof request.body?.targetId === "string" ? request.body.targetId : typeof request.body?.into === "string" ? request.body.into : undefined;
    const result = mergeTopicsUseCase(request.params.topicId, target);
    return result.ok ? reply.send({ topic: result.value }) : rejected(reply, result.failure);
  });
}
