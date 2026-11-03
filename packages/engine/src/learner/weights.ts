import type { AttemptKind, MasteryLevel } from "@codebase-tutor/domain";

/** 证据权重：真跑测试最硬，逐项比对次之，rubric 最软。 */
const EVIDENCE_WEIGHTS: Record<string, number> = { execution: 1, set_match: 0.8, rubric: 0.5 };

/**
  作答权重：首次/重试都算「非到期复习」这一档；到期复习通过只加 0.5，失败扣 1.0。
  规格只给了首次与复习四档，retry 归入首次这一档（同一次学习内的重复作答，不重复记首答奖励）。
*/
const ANSWER_WEIGHTS = {
  correct: 1,
  wrong: -0.6,
  reviewCorrect: 0.5,
  reviewWrong: -1
} as const;

export function evidenceWeight(gradingMode: unknown, kind?: unknown): number {
  if (typeof gradingMode === "string" && EVIDENCE_WEIGHTS[gradingMode] !== undefined) return EVIDENCE_WEIGHTS[gradingMode]!;
  // 旧事件可能没有 grading_mode：按题型回落，未知一律按 set_match。
  if (kind === "llm_rubric") return EVIDENCE_WEIGHTS.rubric!;
  if (kind === "patch_edit" || kind === "author_function") return EVIDENCE_WEIGHTS.execution!;
  return EVIDENCE_WEIGHTS.set_match!;
}

export function answerWeight(attemptKind: AttemptKind, passed: boolean): number {
  if (attemptKind === "review") return passed ? ANSWER_WEIGHTS.reviewCorrect : ANSWER_WEIGHTS.reviewWrong;
  return passed ? ANSWER_WEIGHTS.correct : ANSWER_WEIGHTS.wrong;
}

/** 一次作答对掌握度的增量；score 累加后 clamp 到 0..5。 */
export function attemptDelta(evidence: { gradingMode?: unknown; kind?: unknown }, attempt: { attemptKind: AttemptKind; passed: boolean }): number {
  return evidenceWeight(evidence.gradingMode, evidence.kind) * answerWeight(attempt.attemptKind, attempt.passed);
}

export function clampScore(score: number): number {
  return Math.max(0, Math.min(5, score));
}

/** 加权分数只给 ZPD 路由用：四舍五入到五档。 */
export function levelOf(score: number): MasteryLevel {
  return Math.max(0, Math.min(5, Math.round(clampScore(score)))) as MasteryLevel;
}

/** 尝试次数 5 次即满信；不足 5 次按比例。 */
export function confidenceOf(attempts: number): number {
  return Math.min(1, attempts / 5);
}
