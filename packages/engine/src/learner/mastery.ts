import type { JournalEvent, MasteryLevel, MasteryMapEntry, MasteryRecord } from "@codebase-tutor/domain";
import { isLiveExerciseUnit } from "@codebase-tutor/domain";

/** 掌握度从 journal 的 `exercise_result` 事件回放，真源只有 journal。 */

export function deriveMastery(events: JournalEvent[]): MasteryRecord[] {
  const records = new Map<string, MasteryRecord>();
  for (const event of [...events].sort((left, right) => left.at.localeCompare(right.at))) {
    const unitId = typeof event.payload.unit_id === "string"
      ? event.payload.unit_id
      : typeof event.payload.target_unit_id === "string" ? event.payload.target_unit_id : undefined;
    if (!unitId || !isLiveExerciseUnit(unitId) || event.type !== "exercise_result") continue;
    const current = records.get(unitId) ?? { unitId, level: 0 as MasteryLevel, attempts: 0, successes: 0 };
    const passed = event.payload.passed === true;
    const level = Math.max(0, Math.min(5, current.level + (passed ? 1 : -1))) as MasteryLevel;
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

/** 在 `deriveMastery` 的结果上补成功率。 */
export function deriveMasteryMap(events: JournalEvent[]): MasteryMapEntry[] {
  return deriveMastery(events).map((record) => ({ ...record, successRate: record.attempts ? record.successes / record.attempts : 0 }));
}
