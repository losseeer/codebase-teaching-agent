import type { Landing } from "./exam-points.js";
import type { PointTiers } from "./exam-plan.js";

/**
  离线抽检（方案 v8 第 6 章）：先看样本量，再看可考率。
  工具只产出「待人工标注的样本」与「按标注算出的档位」，不自己判断某处代码能不能出题。
*/
export const MIN_HITS = 10;
export const TOP_N = 20;
export const TAIL_N = 20;

export type TierDecision = "enabled" | "observe" | "grey" | "disabled" | "tune_signal" | "insufficient";

export interface AuditSample {
  pointId: string;
  path: string;
  line?: number;
  symbol?: string;
  signal: number;
  group: "A" | "B";
}

export interface PointAudit {
  pointId: string;
  hits: number;
  /** 命中 <10：样本不足，只记观察中，不定档。 */
  decision: "insufficient";
  samples: AuditSample[];
}

export interface ReadyPointAudit {
  pointId: string;
  hits: number;
  samples: AuditSample[];
}

/** 按 signal 降序，A 取前 20，B 从剩余里确定性取 20（不用随机，抽检可复现）。 */
export function buildAuditSamples(pointId: string, landings: Landing[]): PointAudit | ReadyPointAudit {
  const sorted = [...landings].sort((left, right) => right.signal - left.signal || left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0));
  const sample = (landing: Landing, group: "A" | "B"): AuditSample => ({
    pointId, path: landing.path, ...(landing.line === undefined ? {} : { line: landing.line }),
    ...(landing.symbol ? { symbol: landing.symbol } : {}), signal: landing.signal, group
  });
  if (sorted.length < MIN_HITS) return { pointId, hits: sorted.length, decision: "insufficient", samples: sorted.map((landing) => sample(landing, "A")) };
  const top = sorted.slice(0, TOP_N).map((landing) => sample(landing, "A"));
  const tailPool = sorted.slice(TOP_N);
  const step = Math.max(1, Math.floor(tailPool.length / TAIL_N));
  const tail = tailPool.filter((_, index) => index % step === 0).slice(0, TAIL_N).map((landing) => sample(landing, "B"));
  return { pointId, hits: sorted.length, samples: [...top, ...tail] };
}

/**
  六分支（含样本门槛）。observeRounds 是「连续落在 25–50% 观察区的轮数」，
  连续 3 轮才降灰区——20 条样本在这个区间噪声太大，不单次定档。
*/
export function decideTier(aRate: number, bRate: number, observeRounds = 0): TierDecision {
  if (aRate >= 0.5) return "enabled";
  if (aRate >= 0.25) return observeRounds >= 3 ? "grey" : "observe";
  if (bRate < 0.25) return "disabled";
  if (bRate < 0.5) return "grey";
  return "tune_signal";
}

export interface LabeledRates {
  aRate: number;
  bRate: number;
  observeRounds?: number;
}

/** 把人工标注后的档位汇总成 judgeThemeLandings 能吃的 PointTiers。 */
export function tiersOfDecisions(decisions: Record<string, TierDecision>): PointTiers {
  const enabled: string[] = [];
  const grey: string[] = [];
  const disabled: string[] = [];
  for (const [id, decision] of Object.entries(decisions)) {
    if (decision === "enabled" || decision === "observe" || decision === "tune_signal" || decision === "insufficient") enabled.push(id);
    else if (decision === "grey") grey.push(id);
    else disabled.push(id);
  }
  return { enabled: enabled.sort(), grey: grey.sort(), disabled: disabled.sort() };
}
