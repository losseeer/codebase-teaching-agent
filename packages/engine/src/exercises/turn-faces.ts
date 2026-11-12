import type { AgentScope, PracticeOperation } from "@codebase-tutor/contract";
import type { ReadToolLoopInput } from "../source/tool-loop.js";
import type { ReadToolProgress } from "../source/tools/types.js";
import type { ExamPlan } from "./exam-plan.js";

/**
  出题、判分、讲评这几趟共用的取证面。
  形状直接取自工具循环的入参：这几趟与问答回合走同一条循环，不再各有一套特例。
*/
export type ExerciseFaces = Pick<ReadToolLoopInput, "repoPath" | "search" | "facts" | "skills" | "external" | "budgetGuard" | "signal" | "onTrace" | "budgetBrief" | "maxRounds" | "toolChoiceRequiredRounds"> & { scope?: AgentScope; /** 出题前的主题落点判定结果，由 Exercises.next() 注入。 */ examPlan?: ExamPlan; themeFallback?: boolean };

/** 各练习操作实际装配的取证面；运行时 ExerciseFaces 与只读能力清单共用这一份。 */
export const PRACTICE_FACE_PLAN: Record<PracticeOperation, { search: boolean; facts: boolean; skills: boolean }> = {
  chat: { search: false, facts: false, skills: true },
  generate: { search: true, facts: true, skills: true },
  grade: { search: true, facts: true, skills: true },
  explain: { search: true, facts: true, skills: true }
};

/** 出题进度帧：stage 是稳定键，detail 给 tooltip。 */
export interface ExerciseProgress {
  stage: string;
  detail?: string;
}
export type ExerciseProgressSink = (progress: ExerciseProgress) => void;

/** 工具循环的过程帧 → 出题进度；只推看得懂的那几类，思考帧丢掉。 */
export function forwardToolProgress(sink?: ExerciseProgressSink): ((progress: ReadToolProgress) => void) | undefined {
  if (!sink) return undefined;
  return (progress) => {
    switch (progress.type) {
      case "searching": sink({ stage: "searching", detail: progress.query }); return;
      case "reading": sink({ stage: "reading", detail: progress.path }); return;
      case "loading_skill": sink({ stage: "loading_skill", detail: progress.skill }); return;
      case "querying_facts": sink({ stage: "querying_facts" }); return;
      default: return;
    }
  };
}
