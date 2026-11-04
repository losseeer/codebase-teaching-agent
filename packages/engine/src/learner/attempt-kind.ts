import type { AttemptKind, JournalEvent } from "@codebase-tutor/domain";

const ATTEMPT_KINDS: AttemptKind[] = ["first", "retry", "review"];

/** 显式字段优先；旧 journal 按同一 exercise_id 首条 first、后续 retry。 */
export function attemptKindOf(event: JournalEvent, seenExercises: Set<string>): AttemptKind {
  const key = typeof event.payload.exercise_id === "string" ? event.payload.exercise_id : event.id;
  const recorded = event.payload.attempt_kind;
  const kind = typeof recorded === "string" && ATTEMPT_KINDS.includes(recorded as AttemptKind)
    ? recorded as AttemptKind
    : seenExercises.has(key) ? "retry" : "first";
  seenExercises.add(key);
  return kind;
}
