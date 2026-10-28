import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@codebase-tutor/domain";

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
      event("exercise_result", "2026-10-01T00:00:00.000Z", { target_unit_id: "impact:src/a.py", passed: false, score: 0 }, "s1"),
      event("dependency_event", "2026-10-01T00:01:00.000Z", { unit_id: "impact:src/a.py" }, "s1")
    ]);
    expect(low.recommended.settings).toMatchObject({ style: 100, pedagogy: "socratic", depth: "macro" });

    const highEvents = Array.from({ length: 5 }, (_, index) => event("exercise_result", `2026-10-0${index + 1}T00:00:00.000Z`, { target_unit_id: "impact:src/a.py", passed: true, score: 1 }, `s${index}`));
    const high = deriveLearnerProfile("repo", highEvents);
    expect(high.recommended.settings).toMatchObject({ style: 0, pedagogy: "practice", depth: "micro" });
  });

  it("fades one clue after mastery and replenishes it after failure", () => {
    const mastered = deriveFaded([
      event("unit_mastered", "2026-01-01T00:00:00.000Z", { unit_id: "unit" }),
      event("unit_mastered", "2026-01-02T00:00:00.000Z", { unit_id: "unit" })
    ]);
    expect(mastered).toMatchObject({ mastered: true, sampleCompleteness: 0, hintDepth: 3, transition: "fade" });
    const recovered = deriveFaded([
      event("unit_mastered", "2026-01-01T00:00:00.000Z", { unit_id: "unit" }),
      event("unit_mastered", "2026-01-02T00:00:00.000Z", { unit_id: "unit" }),
      event("exercise_result", "2026-01-03T00:00:00.000Z", { target_unit_id: "unit", passed: false, score: 0 })
    ]);
    expect(recovered).toMatchObject({ sampleCompleteness: 1, hintDepth: 3, stylePlainness: 2, transition: "replenish" });
  });

  /**
    已停用题型留下的练习记录（9 月流程题的 `workflow:`）不再进掌握度回放：
    回放出来就是一张点不开的卡片，而画像与练习选题都只按今天还出得出题的单元说话。
    journal 里那几行不动——那是账本。
  */
  it("只回放今天还认得的单元：workflow 记录退出，impact 与 implementation 留着", () => {
    const profile = deriveLearnerProfile("repo", [
      event("exercise_result", "2026-09-21T12:35:05.000Z", { target_unit_id: "workflow:src/pay.py", passed: true, score: 1 }),
      event("exercise_result", "2026-10-01T00:00:00.000Z", { target_unit_id: "impact:src/a.py", passed: true, score: 1 }),
      event("unit_mastered", "2026-10-02T00:00:00.000Z", { unit_id: "implementation:symbol:src/b.py:run:3" })
    ]);
    expect(profile.mastery.map((record) => record.unitId)).toEqual(["impact:src/a.py", "implementation:symbol:src/b.py:run:3"]);
  });
});
