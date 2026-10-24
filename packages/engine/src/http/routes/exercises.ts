import { type ExerciseAnswer, type ExerciseKind, SUPPORTED_EXERCISE_KINDS } from "@codebase-tutor/shared";
import { budgetDegraded } from "../../application/paid-turn.js";
import { skillsForTurn } from "../../application/scoped-turn.js";
import { exercises, lightLlm, REPOSITORY_NOT_MOUNTED, repositoryOr404 } from "../../services.js";
import type { FastifyInstance } from "fastify";

/**
  练习题的出题、判分与按需讲评。判分是纯本地（沙箱真跑），讲评与 LLM 族出题才走预算闸门。
 */
export function registerExerciseRoutes(app: FastifyInstance): void {
app.post<{ Params: { repositoryId: string }; Body: { kind?: ExerciseKind; targetUnitId?: string; family?: "comprehension" | "llm"; tag?: string; tagId?: string; variantNonce?: number } }>("/api/repositories/:repositoryId/exercises", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  const kind = request.body?.kind;
  const family = request.body?.family === "llm" ? "llm" as const : "comprehension" as const;
  // 非字符串的 `tag` 按没填处理：直接在请求体上做 `.trim()` 会抛 TypeError，把不合规格的请求记成引擎故障
  const tag = typeof request.body?.tag === "string" ? request.body.tag : "";
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  if (family === "llm" && !tag.trim()) return reply.code(400).send({ error: "出题需要先填主题名称" });
  if (kind && !SUPPORTED_EXERCISE_KINDS.includes(kind)) return reply.code(400).send({ error: "不支持的练习题型" });
  const budgetExhausted = budgetDegraded(repository.handle);
  try {
    return reply.code(201).send(await exercises.next(repository, {
      kind,
      targetUnitId: request.body?.targetUnitId,
      family,
      tag,
      tagId: request.body?.tagId,
      variantNonce: request.body?.variantNonce
    }, budgetExhausted ? undefined : lightLlm(), skillsForTurn()));
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "无法生成练习" });
  }
});

app.post<{ Params: { repositoryId: string; exerciseId: string }; Body: ExerciseAnswer }>("/api/repositories/:repositoryId/exercises/:exerciseId/answer", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const provider = budgetDegraded(repository.handle) ? undefined : lightLlm();
  try {
    return await exercises.answer(repository, request.params.exerciseId, request.body ?? {}, provider);
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "无法判分" });
  }
});

/**
  按需讲评（代码题）：判分已经落库，这一趟只补一段解释；未配模型或预算已达上限时照旧 422，
  不回落成本地拼一句模板话。
*/
app.post<{ Params: { repositoryId: string; exerciseId: string }; Body: ExerciseAnswer }>("/api/repositories/:repositoryId/exercises/:exerciseId/explain", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const provider = budgetDegraded(repository.handle) ? undefined : lightLlm();
  try {
    return await exercises.explain(repository, request.params.exerciseId, request.body ?? {}, provider);
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : "无法生成讲评" });
  }
});
}
