import type { RecommendedTutorSettings, UnitMastery } from "@codebase-tutor/domain";

/** 教学层：从学习档案快照现算讲法，不属于记忆结构，也不落库。 */

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function recommendSettings(entries: UnitMastery[]): RecommendedTutorSettings {
  if (!entries.length) {
    return { settings: { pedagogy: "socratic", depth: "macro" }, confidence: "low", reason: "暂无学习记录，使用保守的默认档。" };
  }
  const attempts = entries.reduce((sum, entry) => sum + entry.attempts, 0);
  const averageLevel = average(entries.map((entry) => entry.level)) ?? 1;
  const successRate = average(entries.map((entry) => entry.successRate)) ?? 0;
  if (averageLevel <= 1.5) {
    return { settings: { pedagogy: "socratic", depth: "macro" }, confidence: attempts >= 2 ? "medium" : "low", reason: "掌握度偏低，先用引导式的宏观拆解。" };
  }
  if (averageLevel >= 4 && successRate >= 0.8) {
    return { settings: { pedagogy: "practice", depth: "micro" }, confidence: attempts >= 4 ? "high" : "medium", reason: "连续通过且成功率达标，逐步减少解释并切换到微观练习。" };
  }
  return { settings: { pedagogy: "socratic", depth: "macro" }, confidence: attempts ? "medium" : "low", reason: "证据处于过渡区间，保持苏格拉底式引导。" };
}
