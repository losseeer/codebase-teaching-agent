import type { Exercise, ExerciseAnswer, ExerciseKind } from "@codebase-tutor/domain";
import { SUPPORTED_EXERCISE_KINDS } from "@codebase-tutor/domain";
import { budgetDegraded } from "../orchestration/paid-turn.js";
import { practiceView, withExercisePorts } from "../../infrastructure/exercise-ports.js";
import { skillsForTurn } from "../orchestration/scoped-turn.js";
import { exercises, lightLlm, repositoryOr404 } from "../../infrastructure/composition-root.js";

/**
  练习题的用例：出题、判分、按需讲评。
  三条纪律住在这里，不在 controller：
  - 判分是纯本地（沙箱真跑），不过预算闸门；出题与讲评才要模型，额度触顶就不给 provider；
  - 「没配模型 / 预算用完 / 模型拒答 / 守门否决」一律以 `declined` 报出来，由传输层给 422，不回落本地模板话；
  - 非字符串的 `tag` 按没填处理，绝不在请求体上直接 `.trim()`（那会把不合规格的请求记成引擎故障）；
  - 库句柄在这一层开合（`withExercisePorts` + `practiceView`）：练习服务只拿四个端口，不知道 `pin()/unpin()` 这件事存在。
  */
export type ExerciseFailure =
  | { kind: "repository-missing" }
  | { kind: "tag-required" }
  | { kind: "kind-unsupported" }
  | { kind: "declined"; message: string; fallback: string };

export type ExerciseResult<T> = { ok: true; value: T } | { ok: false; failure: ExerciseFailure };

const declined = (error: unknown, fallback: string): ExerciseResult<never> => ({ ok: false, failure: { kind: "declined", message: error instanceof Error ? error.message : fallback, fallback } });

/** 出题：`family` 决定走规则题还是 LLM 族；额度触顶时传 undefined provider，由服务侧拒。 */
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

/** 判分：本地沙箱真跑，不发模型请求；只有讲评润色那一步会碰 provider。 */
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

/** 按需讲评（代码题）：判分已经落库，这一趟只补一段解释；没模型就照实拒，不拼本地模板话。 */
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
