import type { FadedState, JournalEvent } from "@codebase-tutor/shared";

const initial: FadedState = {
  sampleCompleteness: 2,
  hintDepth: 3,
  stylePlainness: 2,
  mastered: false,
  transition: "steady",
  reason: "尚未出现掌握判定，保留完整辅助。"
};

function isSuccess(event: JournalEvent): boolean {
  return event.type === "unit_mastered" || (event.type === "exercise_result" && event.payload.passed === true && Number(event.payload.score ?? 1) >= 0.8);
}

function isFailure(event: JournalEvent): boolean {
  return event.type === "dependency_event" || (event.type === "exercise_result" && event.payload.passed === false);
}

/**
 * Derives the remaining support clues. A successful mastery event fades one
 * dimension at a time; a failure restores support in the reverse order.
 */
export function deriveFaded(events: JournalEvent[], unitId?: string): FadedState {
  const state: FadedState = { ...initial };
  const relevant = [...events]
    .filter((event) => {
      if (!unitId) return true;
      const eventUnit = event.payload.unit_id ?? event.payload.target_unit_id;
      return eventUnit === unitId || (event.type === "dependency_event" && typeof eventUnit !== "string");
    })
    .sort((left, right) => left.at.localeCompare(right.at));
  for (const event of relevant) {
    if (isSuccess(event)) {
      state.mastered = true;
      if (state.sampleCompleteness > 0) {
        state.sampleCompleteness = (state.sampleCompleteness - 1) as FadedState["sampleCompleteness"];
        state.reason = "掌握判定通过，减少一档样例完整度。";
      } else if (state.hintDepth > 0) {
        state.hintDepth = (state.hintDepth - 1) as FadedState["hintDepth"];
        state.reason = "掌握判定通过，减少一档提示深度。";
      } else if (state.stylePlainness > 0) {
        state.stylePlainness = (state.stylePlainness - 1) as FadedState["stylePlainness"];
        state.reason = "掌握判定通过，减少一档通俗化表达。";
      } else {
        state.reason = "辅助已达到最低档，继续保持独立尝试。";
      }
      state.transition = "fade";
      state.updatedAt = event.at;
    } else if (state.mastered && isFailure(event)) {
      if (state.stylePlainness < 2) {
        state.stylePlainness = (state.stylePlainness + 1) as FadedState["stylePlainness"];
        state.reason = "最近一次失败，回补一档通俗化表达。";
      } else if (state.hintDepth < 3) {
        state.hintDepth = (state.hintDepth + 1) as FadedState["hintDepth"];
        state.reason = "最近一次失败，回补一档提示深度。";
      } else if (state.sampleCompleteness < 2) {
        state.sampleCompleteness = (state.sampleCompleteness + 1) as FadedState["sampleCompleteness"];
        state.reason = "最近一次失败，回补一档样例完整度。";
      } else {
        state.reason = "辅助已处于完整档，保持当前支持。";
      }
      state.transition = "replenish";
      state.updatedAt = event.at;
    }
  }
  return state;
}

export const defaultFadedState: FadedState = { ...initial };
