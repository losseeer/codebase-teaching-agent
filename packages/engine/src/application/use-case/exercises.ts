import type { Exercise, ExerciseAnswer, ExerciseKind } from "@codebase-tutor/domain";
import { SUPPORTED_EXERCISE_KINDS } from "@codebase-tutor/domain";
import { budgetDegraded } from "../orchestration/paid-turn.js";
import { practiceView, withExercisePorts } from "../../infrastructure/exercise-ports.js";
import { skillsForTurn } from "../orchestration/scoped-turn.js";
import { exercises, lightLlm, repositoryOr404 } from "../../infrastructure/composition-root.js";

/**
  练习题的用例：出题、判分、按需讲评。
  判分在本地沙箱真跑，provider 只用于 rubric 评分与反馈润色；出题与讲评需要模型。
  预算到线时 provider 传 undefined；失败一律以 `declined` 报出，不回落到本地模板话术。
*/
export type ExerciseFailure =
  | { kind: "repository-missing" }
  | { kind: "tag-required" }
  | { kind: "kind-unsupported" }
  | { kind: "declined"; message: string; fallback: string };

export type ExerciseResult<T> = { ok: true; value: T } | { ok: false; failure: ExerciseFailure };

const declined = (error: unknown, fallback: string): ExerciseResult<never> => ({ ok: false, failure: { kind: "declined", message: error instanceof Error ? error.message : fallback, fallback } });

/** 出题：`family` 决定走规则题还是 LLM 族；预算到线时 provider 为 undefined。 */
export async function nextExerciseUseCase(repositoryId: string, input: { kind?: ExerciseKind; targetUnitId?: string; family?: "comprehension" | "llm"; tag?: unknown; tagId?: string; variantNonce?: number }): Promise<ExerciseResult<Exercise>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return { ok: false, failure: { kind: "repository-missing" } };
  const family = input.family === "llm" ? "llm" as const : "comprehension" as const;
  const tag = typeof input.tag === "string" ? input.tag : "";
  if (family === "llm" && !tag.trim()) return { ok: false, failure: { kind: "tag-required" } };
  if (input.kind && !SUPPORTED_EXERCISE_KINDS.includes(input.kind)) return { ok: false, failure: { kind: "kind-unsupported" } };
  const provider = budgetDegraded(repository.handle) ? undefined : lightLlm();
  try {
    return { ok: true, value: await withExercisePorts(repository.handle, (ports) => exercises.next(practiceView(repository, ports), { kind: input.kind, targetUnitId: input.targetUnitId, family, tag, tagId: input.tagId, variantNonce: input.variantNonce }, provider, skillsForTurn())) };
  } catch (error) {
    return declined(error, "无法生成练习");
  }
}

/** 判分：执行类题在本地沙箱真跑；rubric 评分与反馈润色可走 provider。 */
export async function answerExerciseUseCase(repositoryId: string, exerciseId: string, answer: ExerciseAnswer): Promise<ExerciseResult<Awaited<ReturnType<typeof exercises.answer>>>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return { ok: false, failure: { kind: "repository-missing" } };
  const provider = budgetDegraded(repository.handle) ? undefined : lightLlm();
  try {
    return { ok: true, value: await withExercisePorts(repository.handle, (ports) => exercises.answer(practiceView(repository, ports), exerciseId, answer ?? {}, provider)) };
  } catch (error) {
    return declined(error, "无法判分");
  }
}

/** 按需讲评：只补一段解释，判分结果已在库里；没有 provider 时直接拒绝。 */
export async function explainExerciseUseCase(repositoryId: string, exerciseId: string, answer: ExerciseAnswer): Promise<ExerciseResult<Awaited<ReturnType<typeof exercises.explain>>>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return { ok: false, failure: { kind: "repository-missing" } };
  const provider = budgetDegraded(repository.handle) ? undefined : lightLlm();
  try {
    return { ok: true, value: await withExercisePorts(repository.handle, (ports) => exercises.explain(practiceView(repository, ports), exerciseId, answer ?? {}, provider)) };
  } catch (error) {
    return declined(error, "无法生成讲评");
  }
}
