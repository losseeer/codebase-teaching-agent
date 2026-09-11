import type { JournalEvent, MasteryLevel, MasteryRecord } from "@codebase-tutor/shared";

export interface ZpdTarget<T> {
  difficulty: MasteryLevel;
  id: string;
  title: string;
  value: T;
}

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

/** Selects an exercise no more than one level from the learner's latest mastery. */
export function selectZpdTarget<T>(targets: ZpdTarget<T>[], records: MasteryRecord[]): ZpdTarget<T> | undefined {
  if (!targets.length) return undefined;
  const mastery = currentMastery(records);
  const candidates = targets.filter((target) => Math.abs(target.difficulty - mastery) <= 1);
  if (!candidates.length) return undefined;
  return [...candidates].sort((left, right) => {
    const difficultyDistance = Math.abs(left.difficulty - mastery) - Math.abs(right.difficulty - mastery);
    return difficultyDistance || left.difficulty - right.difficulty || left.id.localeCompare(right.id);
  })[0];
}
