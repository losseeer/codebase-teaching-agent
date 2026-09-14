import type { TeachingStage } from "@codebase-tutor/shared";

export interface TeachingState {
  stage: TeachingStage;
  fallbackCount: number;
  attempts: number;
}

export type LearnerIntent = "needs_help" | "confirmation" | "progress";

export type TutorAction = Transition["kind"];

export interface Transition {
  next: TeachingState;
  kind: "advance" | "step_down" | "give_answer" | "confirm";
  hintDepth: number;
}

const uncertain = /(不知道|不清楚|不会|给答案|直接告诉|help|answer)/i;
const confirmation = /(明白|理解|因为|所以|therefore|means)/i;

export function initialTeachingState(): TeachingState {
  return { stage: "orient", fallbackCount: 0, attempts: 0 };
}

/** 正则意图分类——LLM 分类器不可用时的回落路径。 */
export function classifyIntentRegex(state: TeachingState, learnerMessage: string): LearnerIntent {
  if (uncertain.test(learnerMessage.trim())) return "needs_help";
  if (confirmation.test(learnerMessage)) return "confirmation";
  return "progress";
}

/**
 * The first request for an answer lowers one scaffold. A second consecutive request
 * is the Phase 0 circuit breaker: give the answer, record dependency, then verify.
 * 确认只有在 verify 阶段才生效——意图本身不带阶段语义，门禁留在这里。
 */
export function transitionFromIntent(state: TeachingState, intent: LearnerIntent): Transition {
  const attempts = state.attempts + 1;
  if (intent === "needs_help") {
    const fallbackCount = state.fallbackCount + 1;
    if (fallbackCount >= 2) {
      return { next: { stage: "verify", fallbackCount, attempts }, kind: "give_answer", hintDepth: 3 };
    }
    return { next: { stage: state.stage, fallbackCount, attempts }, kind: "step_down", hintDepth: Math.min(2, attempts) };
  }
  if (intent === "confirmation" && state.stage === "verify") {
    return { next: { stage: "confirmed", fallbackCount: 0, attempts }, kind: "confirm", hintDepth: 0 };
  }
  const stages: TeachingStage[] = ["orient", "procedure", "concept", "verify"];
  const position = stages.indexOf(state.stage);
  const stage = position < 0 ? "confirmed" : stages[Math.min(position + 1, stages.length - 1)];
  return { next: { stage, fallbackCount: 0, attempts }, kind: "advance", hintDepth: Math.max(0, 3 - Math.min(attempts, 3)) };
}

/** 正则路径：意图分类 + 确定性计数转移，行为与拆分前逐字节一致。 */
export function transition(state: TeachingState, learnerMessage: string): Transition {
  return transitionFromIntent(state, classifyIntentRegex(state, learnerMessage));
}

/** 动作 → 意图的唯一映射：give_answer 必然走 needs_help 的熔断分支（前提是守门已放行）。 */
export function transitionFromAction(state: TeachingState, action: TutorAction): Transition {
  const intent: LearnerIntent = action === "advance" ? "progress" : action === "confirm" ? "confirmation" : "needs_help";
  return transitionFromIntent(state, intent);
}

export const stageLabel: Record<TeachingStage, string> = {
  orient: "L1 定向",
  procedure: "L2 程序",
  concept: "L3 概念",
  verify: "检验",
  confirmed: "确认"
};
