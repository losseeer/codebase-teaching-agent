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
    // `unit_mastered` 的生产者（教学状态机的确认档）已于 2026-10-14 撤掉：这里仍读它，
    // 是为了让「历史上学通过」继续算数——它是一次真实通过，不是会过期的信号。
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

  2026-10-14 撤掉教学状态机时，这里原本还从 `hint_depth` / `dependency_event` 捞「平均提示深度」与
  「依赖事件数」两项。那两个生产者已经不写了，留着会让画像**永久卡在历史某次的熔断上**
  （画像回放的是整本 journal，没有新行去稀释它），所以一并删掉。
  历史行仍在 journal 里，要回看走 `pnpm run-trace`。
  */
export function deriveMasteryMap(events: JournalEvent[]): MasteryMapEntry[] {
  return deriveMastery(events).map((record) => ({ ...record, successRate: record.attempts ? record.successes / record.attempts : 0 }));
}
