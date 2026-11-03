import type { AttemptKind, JournalEvent, MasteryLevel, MasteryRecord, UnitMastery } from "@codebase-tutor/domain";
import { isLiveExerciseUnit } from "@codebase-tutor/domain";

import { attemptDelta, clampScore, confidenceOf, levelOf } from "./weights.js";

/** 掌握度从 journal 的 `exercise_result` 事件回放，真源只有 journal。 */

const ATTEMPT_KINDS: AttemptKind[] = ["first", "retry", "review"];

function unitIdOf(event: JournalEvent): string | undefined {
  return typeof event.payload.unit_id === "string"
    ? event.payload.unit_id
    : typeof event.payload.target_unit_id === "string" ? event.payload.target_unit_id : undefined;
}

/**
  旧 journal 没有 `attempt_kind`：同一 `exercise_id` 第一次出现记 first，之后记 retry。
  到期复习无法从旧行反推，统一按非复习处理——那是旧数据缺的字段，不猜。
*/
function attemptKindOf(event: JournalEvent, seenExercises: Set<string>): AttemptKind {
  const recorded = event.payload.attempt_kind;
  if (typeof recorded === "string" && (ATTEMPT_KINDS as string[]).includes(recorded)) return recorded as AttemptKind;
  const key = typeof event.payload.exercise_id === "string" ? event.payload.exercise_id : event.id;
  if (seenExercises.has(key)) return "retry";
  seenExercises.add(key);
  return "first";
}

export function deriveMastery(events: JournalEvent[]): UnitMastery[] {
  const records = new Map<string, UnitMastery>();
  const seenExercises = new Set<string>();
  for (const event of [...events].sort((left, right) => left.at.localeCompare(right.at))) {
    if (event.type !== "exercise_result") continue;
    const unitId = unitIdOf(event);
    const attemptKind = attemptKindOf(event, seenExercises);
    if (!unitId || !isLiveExerciseUnit(unitId)) continue;
    const passed = event.payload.passed === true;
    const current = records.get(unitId) ?? {
      unitId,
      score: 0,
      level: 0 as MasteryLevel,
      attempts: 0,
      successes: 0,
      successRate: 0,
      confidence: 0
    };
    const score = clampScore(current.score + attemptDelta(
      { gradingMode: event.payload.grading_mode, kind: event.payload.kind },
      { attemptKind, passed }
    ));
    const attempts = current.attempts + 1;
    const successes = current.successes + (passed ? 1 : 0);
    records.set(unitId, {
      unitId,
      score,
      level: levelOf(score),
      attempts,
      successes,
      successRate: successes / attempts,
      confidence: confidenceOf(attempts),
      lastPracticedAt: event.at
    });
  }
  return [...records.values()].sort((left, right) => left.unitId.localeCompare(right.unitId));
}

export function currentMastery(records: MasteryRecord[]): MasteryLevel {
  const mostRecent = [...records].sort((left, right) => (right.lastPracticedAt ?? "").localeCompare(left.lastPracticedAt ?? ""))[0];
  return mostRecent?.level ?? 1;
}


