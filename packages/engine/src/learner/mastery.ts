import type { JournalEvent, MasteryLevel, MasteryMapEntry, MasteryRecord } from "@codebase-tutor/domain";
import { isLiveExerciseUnit } from "@codebase-tutor/domain";

/**
  掌握度的推导层：从 journal 的练习结果与「已掌握」事件回放出一条曲线。
  放这里而不是 exercises/——`learner/model.ts`（学习者画像）与练习选题都要用它，
  真源只有 journal，两处都是消费者。
  只收今天还认得的单元：已停用题型的 id 回放出来是一张点不开的卡片（见 `isLiveExerciseUnit`）。
  */

export function deriveMastery(events: JournalEvent[]): MasteryRecord[] {
  const records = new Map<string, MasteryRecord>();
  for (const event of [...events].sort((left, right) => left.at.localeCompare(right.at))) {
    const unitId = typeof event.payload.unit_id === "string"
      ? event.payload.unit_id
      : typeof event.payload.target_unit_id === "string" ? event.payload.target_unit_id : undefined;
    if (!unitId || !isLiveExerciseUnit(unitId) || (event.type !== "exercise_result" && event.type !== "unit_mastered")) continue;
    // `unit_mastered` 已没有生产者，但这里仍读它：历史上学通过是一次真实通过，不是会过期的信号。
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

/**
  `deriveMastery` 的加料版：补一个成功率——学习画像的设置推荐吃这一份。
  这里不聚合提示深度、依赖事件数这类信号：画像回放整本 journal，
  生产者已停写的字段没有新行稀释，会永久停在历史读数上，不再是当前信号。
  */
export function deriveMasteryMap(events: JournalEvent[]): MasteryMapEntry[] {
  return deriveMastery(events).map((record) => ({ ...record, successRate: record.attempts ? record.successes / record.attempts : 0 }));
}
