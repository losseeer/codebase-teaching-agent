import type { ExerciseAnswer, ExerciseKind } from "@codebase-tutor/domain";
import { REPOSITORY_NOT_MOUNTED } from "../../../../infrastructure/composition-root.js";
import { answerExerciseUseCase, explainExerciseUseCase, nextExerciseUseCase, type ExerciseFailure } from "../../../../application/use-case/exercises.js";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
  练习题的入站翻译：出题、判分、按需讲评三条端点。
  判断在 `application/use-case/exercises.ts`，这里只把失败种类翻成状态码。
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
  app.post<{ Params: { repositoryId: string }; Body: { kind?: ExerciseKind; targetUnitId?: string; family?: "comprehension" | "llm"; tag?: unknown; tagId?: string; variantNonce?: number } }>("/api/repositories/:repositoryId/exercises", async (request, reply) => {
    const body = request.body ?? {};
    const result = await nextExerciseUseCase(request.params.repositoryId, { kind: body.kind, targetUnitId: body.targetUnitId, family: body.family, tag: body.tag, tagId: body.tagId, variantNonce: body.variantNonce });
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
