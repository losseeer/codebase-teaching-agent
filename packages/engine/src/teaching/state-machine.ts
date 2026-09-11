import type { TeachingStage } from "@codebase-tutor/shared";

export interface TeachingState {
  stage: TeachingStage;
  fallbackCount: number;
  attempts: number;
}

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

/**
 * The first request for an answer lowers one scaffold. A second consecutive request
 * is the Phase 0 circuit breaker: give the answer, record dependency, then verify.
 */
export function transition(state: TeachingState, learnerMessage: string): Transition {
  const needsHelp = uncertain.test(learnerMessage.trim());
  const attempts = state.attempts + 1;
  if (needsHelp) {
    const fallbackCount = state.fallbackCount + 1;
    if (fallbackCount >= 2) {
      return { next: { stage: "verify", fallbackCount, attempts }, kind: "give_answer", hintDepth: 3 };
    }
    return { next: { stage: state.stage, fallbackCount, attempts }, kind: "step_down", hintDepth: Math.min(2, attempts) };
  }
  if (state.stage === "verify" && confirmation.test(learnerMessage)) {
    return { next: { stage: "confirmed", fallbackCount: 0, attempts }, kind: "confirm", hintDepth: 0 };
  }
  const stages: TeachingStage[] = ["orient", "procedure", "concept", "verify"];
  const position = stages.indexOf(state.stage);
  const stage = position < 0 ? "confirmed" : stages[Math.min(position + 1, stages.length - 1)];
  return { next: { stage, fallbackCount: 0, attempts }, kind: "advance", hintDepth: Math.max(0, 3 - Math.min(attempts, 3)) };
}

export const stageLabel: Record<TeachingStage, string> = {
  orient: "L1 定向",
  procedure: "L2 程序",
  concept: "L3 概念",
  verify: "检验",
  confirmed: "确认"
};
