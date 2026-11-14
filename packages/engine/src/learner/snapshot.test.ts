import { describe, expect, it } from "vitest";
import type { JournalEvent, RepoLearningRecord } from "@codebase-tutor/domain";

import { buildLearnerSnapshot } from "./snapshot.js";

function event(at: string, payload: JournalEvent["payload"], type: JournalEvent["type"] = "exercise_result"): JournalEvent {
  return { id: at, type, at, repositoryId: "repo", payload };
}

const record: RepoLearningRecord = {
  repositoryId: "repo",
  generatedAt: "2026-11-03T00:00:00.000Z",
  modelVersion: "mastery-v0",
  mastery: [],
  dueReviews: 2
};

describe("学习快照", () => {
  it("按最近练过的主题报次数、首次/复习通过、置信度与几天前", () => {
    const snapshot = buildLearnerSnapshot({
      record,
      events: [
        event("2026-10-31T00:00:00.000Z", { topic_id: "custom-a", target_unit_id: "llm:custom-a:0", passed: true, attempt_kind: "first" }),
        event("2026-11-01T00:00:00.000Z", { topic_id: "custom-a", target_unit_id: "llm:custom-a:0", passed: true, attempt_kind: "review" }),
        event("2026-11-02T00:00:00.000Z", { topic_id: "custom-a", target_unit_id: "llm:custom-a:0", passed: false, attempt_kind: "review" })
      ],
      topicLabels: { "custom-a": "并发控制" },
      now: new Date("2026-11-03T00:00:00.000Z")
    });
    expect(snapshot).toContain("并发控制：3 次，首次通过 1，复习通过 1，置信度中，1 天前练过");
    expect(snapshot).toContain("待复习：2 题");
    expect(snapshot.length).toBeLessThanOrEqual(500);
  });

  it("旧事件缺 topic_id 时从 llm/llm-code 单元解析；没有事件时回落最新掌握单元", () => {
    const fromUnit = buildLearnerSnapshot({
      record,
      events: [event("2026-11-02T00:00:00.000Z", { target_unit_id: "llm-code:custom-a:0", passed: true })],
      topicLabels: { "custom-a": "并发控制" }
    });
    expect(fromUnit).toContain("并发控制");

    const fallback = buildLearnerSnapshot({
      record: { ...record, mastery: [{ unitId: "impact:src/a.ts", score: 1, level: 1, attempts: 4, successes: 3, successRate: 0.75, confidence: 0.8, lastPracticedAt: "2026-11-02T00:00:00.000Z" }] },
      now: new Date("2026-11-03T00:00:00.000Z")
    });
    expect(fallback).toContain("impact:src/a.ts");
  });
});

describe("问答互动进快照", () => {
  it("统计近七天的文件关注与常读技能，旧记录不进", () => {
    const snapshot = buildLearnerSnapshot({
      record: { ...record, dueReviews: 0 },
      events: [
        event("2026-11-02T00:00:00.000Z", { path: "sl-jump/src/main/java/WalQueue.java", line: 3 }, "file_opened"),
        event("2026-11-02T01:00:00.000Z", { path: "sl-jump/src/main/java/WalQueue.java", line: 9 }, "line_located"),
        event("2026-11-02T02:00:00.000Z", { skill: "exercise-code-concepts", chars: 120, found: true }, "skill_read"),
        event("2026-10-01T00:00:00.000Z", { path: "src/old/Old.java" }, "file_opened")
      ],
      now: new Date("2026-11-03T00:00:00.000Z")
    });
    expect(snapshot).toContain("最近在看：sl-jump/src/main/java/WalQueue.java（2 次）");
    expect(snapshot).toContain("常读技能：exercise-code-concepts（1 次）");
    expect(snapshot).not.toContain("Old.java");
  });
});
