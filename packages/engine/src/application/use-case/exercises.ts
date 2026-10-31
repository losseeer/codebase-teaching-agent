import type { Exercise, ExerciseAnswer, ExerciseKind } from "@codebase-tutor/domain";
import { SUPPORTED_EXERCISE_KINDS } from "@codebase-tutor/domain";
import type { ImportedRepository } from "../../importer/importer.js";
import { budgetDegraded, searchCorpusFor, turnBudgetGuard } from "../orchestration/paid-turn.js";
import { practiceView, withExercisePorts } from "../../infrastructure/exercise-ports.js";
import { skillsForTurn } from "../orchestration/scoped-turn.js";
import { factsToolFor } from "../../infrastructure/canvas-tools.js";
import type { ExerciseFaces } from "../../exercises/turn-faces.js";
import { exercises, lightLlm, repositoryOr404 } from "../../infrastructure/composition-root.js";

/**
  练习题的用例：出题、判分、按需讲评。
  判分在本地沙箱真跑，模型用于 rubric 评分、题面润色与讲评。
  这三趟与问答回合走同一条取证循环：有仓就能读文件、检索、查静态产物。
*/
export type ExerciseFailure =
  | { kind: "repository-missing" }
  | { kind: "tag-required" }
  | { kind: "kind-unsupported" }
  | { kind: "declined"; message: string; fallback: string };

export type ExerciseResult<T> = { ok: true; value: T } | { ok: false; failure: ExerciseFailure };

const declined = (error: unknown, fallback: string): ExerciseResult<never> => ({ ok: false, failure: { kind: "declined", message: error instanceof Error ? error.message : fallback, fallback } });

/** 一次练习回合的取证面：检索语料与静态产物都按这次的仓现建。 */
function exerciseFaces(repository: ImportedRepository, database: Parameters<typeof factsToolFor>[1]): ExerciseFaces {
  const skills = skillsForTurn();
  return {
    repoPath: repository.path,
    search: searchCorpusFor(repository),
    facts: factsToolFor(repository, database),
    ...(skills ? { skills } : {}),
    budgetGuard: turnBudgetGuard(repository.handle)
  };
}

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
    return { ok: true, value: await withExercisePorts(repository.handle, (ports, database) => exercises.next(practiceView(repository, ports), { kind: input.kind, targetUnitId: input.targetUnitId, family, tag, tagId: input.tagId, variantNonce: input.variantNonce }, provider, provider ? exerciseFaces(repository, database) : undefined)) };
  } catch (error) {
    return declined(error, "无法生成练习");
  }
}

/** 判分：执行类题在本地沙箱真跑；rubric 评分与反馈润色走模型。 */
export async function answerExerciseUseCase(repositoryId: string, exerciseId: string, answer: ExerciseAnswer): Promise<ExerciseResult<Awaited<ReturnType<typeof exercises.answer>>>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return { ok: false, failure: { kind: "repository-missing" } };
  const provider = budgetDegraded(repository.handle) ? undefined : lightLlm();
  try {
    return { ok: true, value: await withExercisePorts(repository.handle, (ports, database) => exercises.answer(practiceView(repository, ports), exerciseId, answer ?? {}, provider, provider ? exerciseFaces(repository, database) : undefined)) };
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
    return { ok: true, value: await withExercisePorts(repository.handle, (ports, database) => exercises.explain(practiceView(repository, ports), exerciseId, answer ?? {}, provider, provider ? exerciseFaces(repository, database) : undefined)) };
  } catch (error) {
    return declined(error, "无法生成讲评");
  }
}
