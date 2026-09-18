import type { JournalEvent, LearnerProfile, MasteryMapEntry, RecommendedTutorSettings, TutorSettings } from "@codebase-tutor/shared";
import { deriveMastery } from "../exercises/learner.js";
import { deriveFaded } from "./faded.js";

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function recommend(entries: MasteryMapEntry[]): RecommendedTutorSettings {
  if (!entries.length) {
    return { settings: { style: 50, pedagogy: "socratic", depth: "macro" }, confidence: "low", reason: "暂无学习记录，使用保守的中性默认档。" };
  }
  const attempts = entries.reduce((sum, entry) => sum + entry.attempts, 0);
  const averageLevel = average(entries.map((entry) => entry.level)) ?? 1;
  const dependencyEvents = entries.reduce((sum, entry) => sum + entry.dependencyEvents, 0);
  const successRate = entries.length ? average(entries.map((entry) => entry.successRate)) ?? 0 : 0;
  if (averageLevel <= 1.5 || dependencyEvents >= 2) {
    return { settings: { style: 100, pedagogy: "socratic", depth: "macro" }, confidence: attempts >= 2 ? "medium" : "low", reason: "掌握度偏低或依赖事件较多，先用通俗、引导式的宏观拆解。" };
  }
  if (averageLevel >= 4 && successRate >= 0.8 && dependencyEvents === 0) {
    return { settings: { style: 0, pedagogy: "practice", depth: "micro" }, confidence: attempts >= 4 ? "high" : "medium", reason: "连续通过且依赖事件为零，逐步减少解释并切换到微观练习。" };
  }
  return { settings: { style: 50, pedagogy: "socratic", depth: "macro" }, confidence: attempts ? "medium" : "low", reason: "证据处于过渡区间，保持中性风格和苏格拉底式引导。" };
}

export function deriveMasteryMap(events: JournalEvent[]): MasteryMapEntry[] {
  const records = deriveMastery(events);
  return records.map((record) => {
    const unitEvents = events.filter((event) => event.payload.unit_id === record.unitId || event.payload.target_unit_id === record.unitId);
    const hints = unitEvents.filter((event) => event.type === "hint_depth").map((event) => Number(event.payload.depth)).filter(Number.isFinite);
    const dependencies = unitEvents.filter((event) => event.type === "dependency_event").length;
    const stage = [...unitEvents].reverse().find((event) => typeof event.payload.stage === "string")?.payload.stage;
    return {
      ...record,
      successRate: record.attempts ? record.successes / record.attempts : 0,
      dependencyEvents: dependencies,
      averageHintDepth: average(hints),
      ...(stage ? { lastStage: stage as MasteryMapEntry["lastStage"] } : {})
    };
  });
}

export function deriveLearnerProfile(repositoryId: string, events: JournalEvent[], now = new Date()): LearnerProfile {
  const mastery = deriveMasteryMap(events);
  const unitIds = [...new Set(events.map((event) => {
    const value = event.payload.unit_id ?? event.payload.target_unit_id;
    return typeof value === "string" ? value : undefined;
  }).filter((value): value is string => Boolean(value)))];
  const fadedByUnit = Object.fromEntries(unitIds.map((unitId) => [unitId, deriveFaded(events, unitId)]));
  return {
    repositoryId,
    generatedAt: now.toISOString(),
    mastery,
    faded: deriveFaded(events),
    fadedByUnit,
    recommended: recommend(mastery)
  };
}

export function recommendedSettings(profile: LearnerProfile): TutorSettings {
  return profile.recommended.settings;
}
