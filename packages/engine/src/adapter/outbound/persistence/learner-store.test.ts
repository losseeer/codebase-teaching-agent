import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LearnerStore } from "./learner-store.js";

const directories: string[] = [];
const stores: LearnerStore[] = [];

function store(): LearnerStore {
  const directory = mkdtempSync(join(tmpdir(), "tutor-learner-"));
  directories.push(directory);
  const instance = new LearnerStore(join(directory, "learner.db"));
  stores.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of stores.splice(0)) instance.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("全局学习库", () => {
  it("主题 CRUD：改名保留 id，软删后从活跃列表消失", () => {
    const db = store();
    expect(db.modelVersion).toBe("mastery-v0");
    const topic = db.createTopic({ id: "custom-a", label: "并发控制", hint: "线程安全" });
    expect(topic).toMatchObject({ id: "custom-a", label: "并发控制" });
    expect(db.listTopics()).toHaveLength(1);

    expect(db.updateTopic("custom-a", { label: "并发与锁" })).toMatchObject({ id: "custom-a", label: "并发与锁" });
    expect(db.listTopics()[0]!.label).toBe("并发与锁");

    expect(db.softDeleteTopic("custom-a")).toBe(true);
    expect(db.listTopics()).toEqual([]);
    expect(db.getTopic("custom-a", true)).toBeDefined();
  });

  it("合并：contribution 迁到目标，源主题写 merged_into 并退出列表", () => {
    const db = store();
    db.createTopic({ id: "custom-a", label: "并发控制" });
    db.createTopic({ id: "custom-b", label: "线程同步" });
    db.appendContribution({
      repositoryId: "repo-1", topicId: "custom-a", exerciseId: "ex-1", unitId: "llm:custom-a:0",
      kind: "llm_rubric", gradingMode: "rubric", attemptKind: "first", score: 0.8, passed: true, at: "2026-10-01T00:00:00.000Z"
    });

    expect(db.mergeTopics("custom-a", "custom-b")).toMatchObject({ id: "custom-b" });
    expect(db.listTopics().map((topic) => topic.id)).toEqual(["custom-b"]);
    expect(db.listContributions({ topicId: "custom-b" })).toHaveLength(1);
    expect(db.listContributions({ topicId: "custom-a" })).toEqual([]);
    expect(db.resolveTopic("custom-a")?.id).toBe("custom-b");
  });

  it("同一事件重复回放只留一行（确定性 id 幂等）", () => {
    const db = store();
    const row = {
      repositoryId: "repo-1", topicId: "custom-a", exerciseId: "ex-1", unitId: "llm:custom-a:0",
      kind: "llm_rubric", gradingMode: "rubric", attemptKind: "first" as const, score: 1, passed: true, at: "2026-10-01T00:00:00.000Z"
    };
    db.appendContribution(row);
    db.appendContribution(row);
    expect(db.listContributions({ repositoryId: "repo-1" })).toHaveLength(1);
  });

  it("遗忘仓库删除 contribution 与仓库元信息，不动主题", () => {
    const db = store();
    db.createTopic({ id: "custom-a", label: "并发控制" });
    db.touchRepository({ repositoryId: "repo-1", label: "repo-1", stacks: ["typescript"] });
    db.appendContribution({
      repositoryId: "repo-1", topicId: "custom-a", exerciseId: "ex-1", unitId: "llm:custom-a:0",
      kind: "llm_rubric", gradingMode: "rubric", attemptKind: "first", score: 1, passed: true, at: "2026-10-01T00:00:00.000Z"
    });

    expect(db.forgetRepository("repo-1").contributions).toBe(1);
    expect(db.listContributions()).toEqual([]);
    expect(db.listRepositoryMeta()).toEqual([]);
    expect(db.listTopics()).toHaveLength(1);
  });
});
