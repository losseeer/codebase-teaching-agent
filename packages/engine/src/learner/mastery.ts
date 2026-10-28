import type { JournalEvent, MasteryLevel, MasteryMapEntry, MasteryRecord } from "@codebase-tutor/domain";
import { isLiveExerciseUnit } from "@codebase-tutor/domain";

/**
  掌握度的推导层：从 journal 的练习结果与「已掌握」事件回放曲线；真源只有 journal。
  只收今天还认得的单元。
  */

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

/** `deriveMastery` 的加料版：补一个成功率，给画像的设置推荐用。 */
export function deriveMasteryMap(events: JournalEvent[]): MasteryMapEntry[] {
  return deriveMastery(events).map((record) => ({ ...record, successRate: record.attempts ? record.successes / record.attempts : 0 }));
}
