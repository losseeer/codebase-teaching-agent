import type { Exercise, ExerciseAnswer, ExerciseBankEntry, ExerciseKind, ExerciseType } from "@codebase-tutor/domain";
import { EXERCISE_TYPE_KINDS, SUPPORTED_EXERCISE_KINDS } from "@codebase-tutor/domain";
import { currentTraceId, id } from "@codebase-tutor/platform";
import type { ExerciseDeclineCode } from "@codebase-tutor/contract";
import type { ImportedRepository } from "../../importer/importer.js";
import { budgetDegraded, searchCorpusFor, turnBudgetGuard } from "../orchestration/paid-turn.js";
import { practiceView, withExercisePorts } from "../../infrastructure/exercise-ports.js";
import { skillsForTurn } from "../orchestration/scoped-turn.js";
import { factsToolFor } from "../../infrastructure/canvas-tools.js";
import type { ExerciseFaces } from "../../exercises/turn-faces.js";
import type { ToolTraceStep } from "../../source/tools/types.js";
import { emitAgentTrace } from "../../turn/agent-trace.js";
import { exercises, lightLlm, repositoryOr404 } from "../../infrastructure/composition-root.js";
import { ExerciseDeclinedError } from "../port/exercise-decline.js";
import { broadcast } from "../../events.js";
import type { ExerciseProgress } from "../../exercises/turn-faces.js";

/**
  练习题的用例：出题、判分、按需讲评。
  判分在本地沙箱真跑，模型用于 rubric 评分、题面润色与讲评。
  这三趟与问答回合走同一条取证循环：有仓就能读文件、检索、查静态产物。
*/
export type ExerciseFailure =
  | { kind: "repository-missing" }
  | { kind: "tag-required" }
  | { kind: "kind-unsupported" }
  | { kind: "declined"; message: string; fallback: string; code?: ExerciseDeclineCode };

export type ExerciseResult<T> = { ok: true; value: T } | { ok: false; failure: ExerciseFailure };

/** 内部阶段 → 公开错误码；只登记界面需要据此给出路的那些。 */
const DECLINE_CODES: Partial<Record<string, ExerciseDeclineCode>> = { no_theme_hits: "theme_not_found" };

const declined = (error: unknown, fallback: string, code?: ExerciseDeclineCode): ExerciseResult<never> => ({ ok: false, failure: { kind: "declined", message: error instanceof Error ? error.message : fallback, fallback, ...(code ? { code } : {}) } });

/** 一次练习回合的取证面：检索语料与静态产物都按这次的仓现建。 */
function exerciseFaces(repository: ImportedRepository, database: Parameters<typeof factsToolFor>[1], onTrace?: (step: ToolTraceStep) => void): ExerciseFaces {
  const skills = skillsForTurn();
  return {
    scope: "practice",
    repoPath: repository.path,
    search: searchCorpusFor(repository),
    facts: factsToolFor(repository, database),
    ...(skills ? { skills } : {}),
    budgetGuard: turnBudgetGuard(repository.handle),
    ...(onTrace ? { onTrace } : {})
  };
}

/** 出题这趟的运行轨迹：起止帧由用例发，模型与工具帧随工具循环回传。 */
function generationTrace(repositoryId: string, label: string): { onTrace: (step: ToolTraceStep) => void; finish: (outcome: string, ok: boolean) => void } {
  const runId = currentTraceId() ?? id();
  const startedAt = Date.now();
  let attempt = 0;
  let current = 0;
  const emit = (step: ToolTraceStep | { kind: "turn"; status: "ok" | "error"; label: string; detail?: string; ms?: number }): void => {
    emitAgentTrace({ repositoryId, runId, scene: "practice.generate", ...step });
  };
  emitAgentTrace({ repositoryId, runId, scene: "practice.generate", kind: "turn", status: "start", label, detail: label });
  return {
    // 修复回合会重新从 m1 开始编号，按轮次加前缀避免覆盖上一轮的模型帧
    onTrace: (step) => {
      if (step.kind === "model" && step.status === "start" && step.stepId === "m1") current = ++attempt;
      emit({ ...step, stepId: `${current}:${step.stepId}` });
    },
    finish: (outcome, ok) => emit({ kind: "turn", status: ok ? "ok" : "error", label: ok ? "出题完成" : "出题失败", detail: outcome, ms: Date.now() - startedAt })
  };
}

/** 出题：题型决定链路（理解题/分析题/设计题），主题只筛目标；预算到线时 provider 为 undefined。 */
export async function nextExerciseUseCase(repositoryId: string, input: { kind?: ExerciseKind; type?: ExerciseType; targetUnitId?: string; tag?: unknown; tagId?: string; variantNonce?: number; jobId?: string }): Promise<ExerciseResult<Exercise>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return { ok: false, failure: { kind: "repository-missing" } };
  const tag = typeof input.tag === "string" ? input.tag : "";
  if (input.kind && !SUPPORTED_EXERCISE_KINDS.includes(input.kind)) return { ok: false, failure: { kind: "kind-unsupported" } };
  if (input.type && !(input.type in EXERCISE_TYPE_KINDS)) return { ok: false, failure: { kind: "kind-unsupported" } };
  if (input.kind === "llm_rubric" && !tag.trim()) return { ok: false, failure: { kind: "tag-required" } };
  const provider = budgetDegraded(repository.handle) ? undefined : lightLlm();
  const jobId = input.jobId?.trim() || undefined;
  // 出题是阻塞请求：阶段帧走全局事件流，客户端按 jobId 认领
  const progress = jobId
    ? (event: ExerciseProgress): void => broadcast({ type: "exercise.progress", payload: { repositoryId, jobId, stage: event.stage, ...(event.detail ? { detail: event.detail.slice(0, 200) } : {}) } })
    : undefined;
  const trace = generationTrace(repository.index.repositoryId, tag ? `出题 · ${tag}` : "出题");
  try {
    const value = await withExercisePorts(repository.handle, (ports, database) => exercises.next(practiceView(repository, ports), { kind: input.kind, type: input.type, targetUnitId: input.targetUnitId, tag, tagId: input.tagId, variantNonce: input.variantNonce }, provider, provider ? exerciseFaces(repository, database, trace.onTrace) : undefined, progress));
    trace.finish(`题目「${value.title}」`, true);
    return { ok: true, value };
  } catch (error) {
    trace.finish(error instanceof Error ? error.message : "出题失败", false);
    const code = error instanceof ExerciseDeclinedError ? DECLINE_CODES[error.stage] : undefined;
    return declined(error, "无法生成练习", code);
  }
}

/** 题库：这个仓存着的题与复习排期，纯读不花钱。 */
export async function listExercisesUseCase(repositoryId: string): Promise<ExerciseResult<ExerciseBankEntry[]>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return { ok: false, failure: { kind: "repository-missing" } };
  return { ok: true, value: await withExercisePorts(repository.handle, (ports) => exercises.bank(practiceView(repository, ports))) };
}

/** 删题：题与复习排期一起删。 */
export async function deleteExerciseUseCase(repositoryId: string, exerciseId: string): Promise<ExerciseResult<{ deleted: number }>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return { ok: false, failure: { kind: "repository-missing" } };
  return { ok: true, value: await withExercisePorts(repository.handle, (ports) => exercises.remove(practiceView(repository, ports), exerciseId)) };
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
