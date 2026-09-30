import type { JournalEvent, MasteryLevel, MasteryMapEntry, MasteryRecord } from "@codebase-tutor/shared";

/**
  掌握度的推导层：从 journal 的练习结果与「已掌握」事件回放出一条曲线。
  放这里而不是 exercises/——`learner/model.ts`（学习者画像）与练习选题都要用它，
  真源只有 journal，两处都是消费者。
  */

export function deriveMastery(events: JournalEvent[]): MasteryRecord[] {
  const records = new Map<string, MasteryRecord>();
  for (const event of [...events].sort((left, right) => left.at.localeCompare(right.at))) {
    const unitId = typeof event.payload.unit_id === "string"
      ? event.payload.unit_id
      : typeof event.payload.target_unit_id === "string" ? event.payload.target_unit_id : undefined;
    if (!unitId || (event.type !== "exercise_result" && event.type !== "unit_mastered")) continue;
    const current = records.get(unitId) ?? { unitId, level: 0 as MasteryLevel, attempts: 0, successes: 0 };
    const passed = event.type === "unit_mastered" || event.payload.passed === true;
    const level = event.type === "unit_mastered"
      ? Math.max(4, current.level) as MasteryLevel
      : Math.max(0, Math.min(5, current.level + (passed ? 1 : -1))) as MasteryLevel;
    records.set(unitId, {
      unitId,
      level,
      attempts: current.attempts + 1,
      successes: current.successes + (passed ? 1 : 0),
      lastPracticedAt: event.at
    });
  }
  return [...records.values()].sort((left, right) => left.unitId.localeCompare(right.unitId));
}

export function currentMastery(records: MasteryRecord[]): MasteryLevel {
  const mostRecent = [...records].sort((left, right) => (right.lastPracticedAt ?? "").localeCompare(left.lastPracticedAt ?? ""))[0];
  return mostRecent?.level ?? 1;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** `deriveMastery` 的按单元加料版：补上提示深度、依赖事件、成功率——学习画像与设置推荐吃这一份。 */
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
