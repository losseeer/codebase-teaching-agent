import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@codebase-tutor/shared";
import { deriveFaded } from "./faded.js";
import { deriveLearnerProfile } from "./model.js";

function event(type: JournalEvent["type"], at: string, payload: JournalEvent["payload"], sessionId?: string): JournalEvent {
  return { id: `${type}-${at}`, type, at, repositoryId: "repo", payload, sessionId };
}

describe("M2.3 learner model", () => {
  it("uses the conservative default when there is no journal data", () => {
    expect(deriveLearnerProfile("repo", []).recommended.settings).toEqual({ style: 50, pedagogy: "socratic", depth: "macro" });
  });

  it("recommends supportive macro settings for low mastery and focused practice for high mastery", () => {
    const low = deriveLearnerProfile("repo", [
      event("exercise_result", "2026-01-01T00:00:00.000Z", { target_unit_id: "unit", passed: false, score: 0 }, "s1"),
      event("dependency_event", "2026-01-01T00:01:00.000Z", { unit_id: "unit" }, "s1")
    ]);
    expect(low.recommended.settings).toMatchObject({ style: 75, pedagogy: "socratic", depth: "macro" });

    const highEvents = Array.from({ length: 5 }, (_, index) => event("exercise_result", `2026-01-0${index + 1}T00:00:00.000Z`, { target_unit_id: "unit", passed: true, score: 1 }, `s${index}`));
    const high = deriveLearnerProfile("repo", highEvents);
    expect(high.recommended.settings).toMatchObject({ style: 25, pedagogy: "practice", depth: "micro" });
  });

  it("fades one clue after mastery and replenishes it after failure", () => {
    const mastered = deriveFaded([
      event("unit_mastered", "2026-01-01T00:00:00.000Z", { unit_id: "unit" }),
      event("unit_mastered", "2026-01-02T00:00:00.000Z", { unit_id: "unit" })
    ], "unit");
    expect(mastered).toMatchObject({ mastered: true, sampleCompleteness: 0, hintDepth: 3, transition: "fade" });
    const recovered = deriveFaded([
      event("unit_mastered", "2026-01-01T00:00:00.000Z", { unit_id: "unit" }),
      event("unit_mastered", "2026-01-02T00:00:00.000Z", { unit_id: "unit" }),
      event("exercise_result", "2026-01-03T00:00:00.000Z", { target_unit_id: "unit", passed: false, score: 0 })
    ], "unit");
    expect(recovered).toMatchObject({ sampleCompleteness: 1, hintDepth: 3, stylePlainness: 2, transition: "replenish" });
  });

});
