import type { Contribution, JournalEvent } from "@codebase-tutor/domain";

import { attemptKindOf } from "./attempt-kind.js";
import { topicIdFromUnit } from "./snapshot.js";

function unitIdOf(event: JournalEvent): string | undefined {
  return typeof event.payload.unit_id === "string"
    ? event.payload.unit_id
    : typeof event.payload.target_unit_id === "string" ? event.payload.target_unit_id : undefined;
}

/** journal 的 `exercise_result` → 跨仓原始证据；一个事件恰好一行。 */
export function projectContributionsFromEvents(events: JournalEvent[], repositoryId: string): Array<Omit<Contribution, "id">> {
  const rows: Array<Omit<Contribution, "id">> = [];
  const seenExercises = new Set<string>();
  for (const event of [...events].sort((left, right) => left.at.localeCompare(right.at))) {
    if (event.type !== "exercise_result") continue;
    const unitId = unitIdOf(event);
    if (!unitId) continue;
    const exerciseId = typeof event.payload.exercise_id === "string" ? event.payload.exercise_id : event.id;
    const attemptKind = attemptKindOf(event, seenExercises);
    const topicId = typeof event.payload.topic_id === "string" ? event.payload.topic_id : topicIdFromUnit(unitId);
    rows.push({
      repositoryId,
      ...(topicId ? { topicId } : {}),
      exerciseId,
      unitId,
      kind: typeof event.payload.kind === "string" ? event.payload.kind : "unknown",
      gradingMode: typeof event.payload.grading_mode === "string" ? event.payload.grading_mode : "",
      attemptKind,
      score: Number(event.payload.score ?? 0),
      passed: event.payload.passed === true,
      at: event.at
    });
  }
  return rows;
}
