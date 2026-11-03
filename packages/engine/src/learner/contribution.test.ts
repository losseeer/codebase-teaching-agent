import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@codebase-tutor/domain";

import { projectContributionsFromEvents } from "./contribution.js";

function event(at: string, payload: JournalEvent["payload"]): JournalEvent {
  return { id: at, type: "exercise_result", at, repositoryId: "repo", payload };
}

describe("旧 journal 回放成 contribution", () => {
  it("缺 attempt_kind 时按 exercise_id 首条 first、后续 retry；缺 topic_id 时从 llm/llm-code 解析", () => {
    const rows = projectContributionsFromEvents([
      event("2026-10-01T00:00:00.000Z", { exercise_id: "ex-1", target_unit_id: "llm:custom-a:0", passed: true, score: 1 }),
      event("2026-10-02T00:00:00.000Z", { exercise_id: "ex-1", target_unit_id: "llm:custom-a:0", passed: false, score: 0 }),
      event("2026-10-03T00:00:00.000Z", { exercise_id: "ex-2", target_unit_id: "llm-code:custom-b:0", passed: true, score: 1, topic_id: "custom-c" })
    ], "repo");

    expect(rows.map((row) => row.attemptKind)).toEqual(["first", "retry", "first"]);
    expect(rows[0]!.topicId).toBe("custom-a");
    expect(rows[2]!.topicId).toBe("custom-c");
    expect(rows[2]!.gradingMode).toBe("");
  });

  it("同一事件重复回放得到同一组字段（写库时由确定性 id 去重）", () => {
    const input = [event("2026-10-01T00:00:00.000Z", { exercise_id: "ex-1", target_unit_id: "impact:a", passed: true, grading_mode: "set_match", attempt_kind: "review" })];
    expect(projectContributionsFromEvents(input, "repo")).toEqual(projectContributionsFromEvents(input, "repo"));
  });
});
