import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@codebase-tutor/domain";

import { deriveFaded } from "./faded.js";
import { deriveRepoLearningRecord } from "./model.js";
import { recommendSettings } from "./teaching-profile.js";

function event(type: JournalEvent["type"], at: string, payload: JournalEvent["payload"], sessionId?: string): JournalEvent {
  return { id: `${type}-${at}`, type, at, repositoryId: "repo", payload, sessionId };
}

describe("M2.3 learner model", () => {
  it("uses the conservative default when there is no journal data", () => {
    expect(recommendSettings(deriveRepoLearningRecord("repo", []).mastery).settings).toEqual({ pedagogy: "socratic", depth: "macro" });
  });

  it("recommends supportive macro settings for low mastery and focused practice for high mastery", () => {
    const low = deriveRepoLearningRecord("repo", [
      event("exercise_result", "2026-10-01T00:00:00.000Z", { target_unit_id: "impact:src/a.py", passed: false, score: 0 }, "s1")
    ]);
    expect(recommendSettings(low.mastery).settings).toMatchObject({ pedagogy: "socratic", depth: "macro" });

    const highEvents = Array.from({ length: 5 }, (_, index) => event("exercise_result", `2026-10-0${index + 1}T00:00:00.000Z`, { target_unit_id: "impact:src/a.py", passed: true, score: 1, grading_mode: "set_match" }, `s${index}`));
    const high = deriveRepoLearningRecord("repo", highEvents);
    expect(recommendSettings(high.mastery).settings).toMatchObject({ pedagogy: "practice", depth: "micro" });
  });

  it("fades one clue after mastery and replenishes it after failure", () => {
    const pass = (at: string) => event("exercise_result", at, { target_unit_id: "impact:src/a.py", passed: true, score: 1 });
    const mastered = deriveFaded([pass("2026-01-01T00:00:00.000Z"), pass("2026-01-02T00:00:00.000Z")]);
    expect(mastered).toMatchObject({ mastered: true, sampleCompleteness: 0, hintDepth: 3, transition: "fade" });
    const recovered = deriveFaded([
      pass("2026-01-01T00:00:00.000Z"),
      pass("2026-01-02T00:00:00.000Z"),
      event("exercise_result", "2026-01-03T00:00:00.000Z", { target_unit_id: "impact:src/a.py", passed: false, score: 0 })
    ]);
    expect(recovered).toMatchObject({ sampleCompleteness: 1, hintDepth: 3, transition: "replenish" });
  });

  // journal 里的 workflow 练习记录只留档，不进掌握度回放
  it("只回放今天还认得的单元：workflow 记录退出，impact 与 implementation 留着", () => {
    const record = deriveRepoLearningRecord("repo", [
      event("exercise_result", "2026-09-21T12:35:05.000Z", { target_unit_id: "workflow:src/pay.py", passed: true, score: 1 }),
      event("exercise_result", "2026-10-01T00:00:00.000Z", { target_unit_id: "impact:src/a.py", passed: true, score: 1 }),
      event("exercise_result", "2026-10-02T00:00:00.000Z", { target_unit_id: "implementation:symbol:src/b.py:run:3", passed: true, score: 1 })
    ]);
    expect(record.mastery.map((entry) => entry.unitId)).toEqual(["impact:src/a.py", "implementation:symbol:src/b.py:run:3"]);
  });

  it("按证据权重与作答权重累加分数：execution 1.0 / set_match 0.8 / rubric 0.5", () => {
    const execution = deriveRepoLearningRecord("repo", [
      event("exercise_result", "2026-10-01T00:00:00.000Z", { target_unit_id: "implementation:symbol:a", passed: true, grading_mode: "execution", attempt_kind: "first" })
    ]);
    expect(execution.mastery[0]).toMatchObject({ score: 1, level: 1, attempts: 1, successes: 1, successRate: 1, confidence: 0.2 });

    const setMatch = deriveRepoLearningRecord("repo", [
      event("exercise_result", "2026-10-01T00:00:00.000Z", { target_unit_id: "impact:a", passed: true, grading_mode: "set_match", attempt_kind: "first" })
    ]);
    expect(setMatch.mastery[0]!.score).toBeCloseTo(0.8);

    const rubric = deriveRepoLearningRecord("repo", [
      event("exercise_result", "2026-10-01T00:00:00.000Z", { target_unit_id: "llm:topic:0", passed: true, grading_mode: "rubric", attempt_kind: "first" })
    ]);
    expect(rubric.mastery[0]!.score).toBeCloseTo(0.5);
  });

  it("首次错与复习错的扣分不同，且分数夹在 0..5", () => {
    const firstWrong = deriveRepoLearningRecord("repo", [
      event("exercise_result", "2026-10-01T00:00:00.000Z", { target_unit_id: "impact:a", passed: false, grading_mode: "set_match", attempt_kind: "first" })
    ]);
    expect(firstWrong.mastery[0]!.score).toBe(0);

    const reviewWrong = deriveRepoLearningRecord("repo", [
      event("exercise_result", "2026-10-01T00:00:00.000Z", { target_unit_id: "impact:a", passed: true, grading_mode: "set_match", attempt_kind: "first" }),
      event("exercise_result", "2026-10-02T00:00:00.000Z", { target_unit_id: "impact:a", passed: false, grading_mode: "set_match", attempt_kind: "review" })
    ]);
    expect(reviewWrong.mastery[0]!.score).toBe(0);
    expect(reviewWrong.mastery[0]!.level).toBe(0);
  });

  it("旧 journal 缺 attempt_kind：同一 exercise_id 首条算 first，后续算 retry", () => {
    const record = deriveRepoLearningRecord("repo", [
      event("exercise_result", "2026-10-01T00:00:00.000Z", { exercise_id: "ex-1", target_unit_id: "impact:a", passed: true }),
      event("exercise_result", "2026-10-02T00:00:00.000Z", { exercise_id: "ex-1", target_unit_id: "impact:a", passed: true }),
      event("exercise_result", "2026-10-03T00:00:00.000Z", { exercise_id: "ex-2", target_unit_id: "impact:b", passed: true })
    ]);
    expect(record.mastery.find((entry) => entry.unitId === "impact:a")!.attempts).toBe(2);
    expect(record.mastery.find((entry) => entry.unitId === "impact:b")!.attempts).toBe(1);
  });
});
