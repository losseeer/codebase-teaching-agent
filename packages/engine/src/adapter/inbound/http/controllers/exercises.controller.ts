import type { ExerciseAnswer, ExerciseKind, ExerciseType } from "@codebase-tutor/domain";
import { REPOSITORY_NOT_MOUNTED } from "../../../../infrastructure/composition-root.js";
import { answerExerciseUseCase, deleteExerciseUseCase, explainExerciseUseCase, listExercisesUseCase, nextExerciseUseCase, type ExerciseFailure } from "../../../../application/use-case/exercises.js";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
  练习题路由的入站翻译：题库、出题、判分、讲评四条端点，失败种类在此翻成状态码。
*/
const rejected = (reply: FastifyReply, failure: ExerciseFailure): FastifyReply => {
  switch (failure.kind) {
    case "repository-missing": return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
    case "tag-required": return reply.code(400).send({ error: "出题需要先填主题名称" });
    case "kind-unsupported": return reply.code(400).send({ error: "不支持的练习题型" });
    case "declined": return reply.code(422).send({ error: failure.message || failure.fallback });
  }
};

export function registerExerciseRoutes(app: FastifyInstance): void {
  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/exercises", async (request, reply) => {
    const result = await listExercisesUseCase(request.params.repositoryId);
    return result.ok ? reply.send({ exercises: result.value }) : rejected(reply, result.failure);
  });

  app.delete<{ Params: { repositoryId: string; exerciseId: string } }>("/api/repositories/:repositoryId/exercises/:exerciseId", async (request, reply) => {
    const result = await deleteExerciseUseCase(request.params.repositoryId, request.params.exerciseId);
    return result.ok ? reply.send(result.value) : rejected(reply, result.failure);
  });

  app.post<{ Params: { repositoryId: string }; Body: { kind?: ExerciseKind; type?: ExerciseType; targetUnitId?: string; tag?: unknown; tagId?: string; variantNonce?: number } }>("/api/repositories/:repositoryId/exercises", async (request, reply) => {
    const body = request.body ?? {};
    const result = await nextExerciseUseCase(request.params.repositoryId, { kind: body.kind, type: body.type, targetUnitId: body.targetUnitId, tag: body.tag, tagId: body.tagId, variantNonce: body.variantNonce });
    return result.ok ? reply.code(201).send(result.value) : rejected(reply, result.failure);
  });

  app.post<{ Params: { repositoryId: string; exerciseId: string }; Body: ExerciseAnswer }>("/api/repositories/:repositoryId/exercises/:exerciseId/answer", async (request, reply) => {
    const result = await answerExerciseUseCase(request.params.repositoryId, request.params.exerciseId, request.body ?? {});
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.post<{ Params: { repositoryId: string; exerciseId: string }; Body: ExerciseAnswer }>("/api/repositories/:repositoryId/exercises/:exerciseId/explain", async (request, reply) => {
    const result = await explainExerciseUseCase(request.params.repositoryId, request.params.exerciseId, request.body ?? {});
    return result.ok ? result.value : rejected(reply, result.failure);
  });
}
