import { describe, expect, it } from "vitest";
import type { Contribution, RepositoryMeta, Topic } from "@codebase-tutor/domain";

import { deriveCrossRepoLearningProfile } from "./cross-repo.js";

const topics: Topic[] = [
  { id: "custom-a", label: "并发控制", hint: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "custom-b", label: "缓存", hint: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
];
const metas: RepositoryMeta[] = [
  { repositoryId: "repo-a", label: "A", stacks: ["typescript", "java"], lastSeenAt: "2026-01-01T00:00:00.000Z" },
  { repositoryId: "repo-b", label: "B", stacks: ["python"], lastSeenAt: "2026-01-01T00:00:00.000Z" }
];

function contribution(overrides: Partial<Contribution>): Contribution {
  return {
    id: "c-1", repositoryId: "repo-a", topicId: "custom-a", exerciseId: "ex-1", unitId: "llm:custom-a:0",
    kind: "llm_rubric", gradingMode: "rubric", attemptKind: "first", score: 1, passed: true, at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("跨仓学习画像", () => {
  it("按主题加权聚合；改名后标签跟随 topic 表", () => {
    const contributions = [
      contribution({ id: "c-1", gradingMode: "set_match", at: "2026-01-01T00:00:00.000Z" }),
      contribution({ id: "c-2", gradingMode: "set_match", attemptKind: "review", at: "2026-01-02T00:00:00.000Z" })
    ];
    const profile = deriveCrossRepoLearningProfile({
      contributions,
      topics: [{ ...topics[0]!, label: "并发与锁" }, topics[1]!],
      repositoryMetas: metas,
      modelVersion: "mastery-v0",
      now: new Date("2026-01-03T00:00:00.000Z")
    });
    expect(profile.topics[0]).toMatchObject({
      topicId: "custom-a",
      label: "并发与锁",
      attempts: 2,
      confidence: 0.4,
      byKind: { llm_rubric: 2 }
    });
    // set_match 首次通过 0.8 + 复习通过 0.4 = 1.2
    expect(profile.topics[0]!.score).toBeCloseTo(1.2);
    expect(profile.frequency[0]).toMatchObject({ topicId: "custom-a", count: 2, lastAt: "2026-01-02T00:00:00.000Z" });
  });

  it("合并后的 contribution 只归目标主题；软删主题不再出现在画像里", () => {
    const merged = deriveCrossRepoLearningProfile({
      contributions: [contribution({ id: "c-1", topicId: "custom-b" })],
      topics,
      repositoryMetas: metas,
      modelVersion: "mastery-v0"
    });
    expect(merged.topics.map((topic) => topic.topicId)).toEqual(["custom-b"]);

    const deleted = deriveCrossRepoLearningProfile({
      contributions: [contribution({ id: "c-1", topicId: "custom-a" })],
      topics: [topics[1]!],
      repositoryMetas: metas,
      modelVersion: "mastery-v0"
    });
    expect(deleted.topics).toEqual([]);
  });

  it("技术栈从 repository_meta 聚合；没有元信息的仓不计入", () => {
    const profile = deriveCrossRepoLearningProfile({
      contributions: [
        contribution({ id: "c-1", repositoryId: "repo-a" }),
        contribution({ id: "c-2", repositoryId: "repo-b", at: "2026-01-02T00:00:00.000Z" }),
        contribution({ id: "c-3", repositoryId: "repo-c" })
      ],
      topics,
      repositoryMetas: metas,
      modelVersion: "mastery-v0"
    });
    expect(profile.stacks).toEqual([
      { stack: "java", attempts: 1, lastPracticedAt: "2026-01-01T00:00:00.000Z" },
      { stack: "python", attempts: 1, lastPracticedAt: "2026-01-02T00:00:00.000Z" },
      { stack: "typescript", attempts: 1, lastPracticedAt: "2026-01-01T00:00:00.000Z" }
    ]);
  });
});
