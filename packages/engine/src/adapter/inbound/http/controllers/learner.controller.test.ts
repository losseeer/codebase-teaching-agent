import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRouteFixture } from "../controller-test-kit.js";

const fx = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });

describe("用户级学习状态路由", () => {
  it("主题 CRUD、改名与合并后画像跟随目标主题", async () => {
    const source = await fx.app.inject({ method: "POST", url: "/api/topics", payload: { id: "custom-source", label: "并发控制", hint: "线程安全" } });
    expect(source.statusCode).toBe(201);
    const target = await fx.app.inject({ method: "POST", url: "/api/topics", payload: { id: "custom-target", label: "线程同步" } });
    expect(target.statusCode).toBe(201);

    const renamed = await fx.app.inject({ method: "PATCH", url: "/api/topics/custom-source", payload: { label: "并发与锁" } });
    expect(renamed.json()).toMatchObject({ topic: { id: "custom-source", label: "并发与锁" } });

    const { learnerStore } = await import("../../../../infrastructure/composition-root.js");
    learnerStore.touchRepository({ repositoryId: fx.repositoryId, label: "fixture", stacks: ["typescript"] });
    learnerStore.appendContribution({
      repositoryId: fx.repositoryId, topicId: "custom-source", exerciseId: "ex-1", unitId: "llm:custom-source:0",
      kind: "llm_rubric", gradingMode: "rubric", attemptKind: "first", score: 1, passed: true, at: "2026-10-01T00:00:00.000Z"
    });

    const profile = await fx.app.inject({ method: "GET", url: "/api/learner/profile" });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({
      modelVersion: "mastery-v0",
      topics: [{ topicId: "custom-source", label: "并发与锁", attempts: 1 }],
      stacks: [{ stack: "typescript", attempts: 1 }]
    });

    const merged = await fx.app.inject({ method: "POST", url: "/api/topics/custom-source/merge", payload: { targetId: "custom-target" } });
    expect(merged.statusCode).toBe(200);
    const afterMerge = await fx.app.inject({ method: "GET", url: "/api/learner/profile" });
    expect(afterMerge.json()).toMatchObject({ topics: [{ topicId: "custom-target", label: "线程同步", attempts: 1 }] });

    const deleted = await fx.app.inject({ method: "DELETE", url: "/api/topics/custom-target" });
    expect(deleted.statusCode).toBe(200);
    const topics = await fx.app.inject({ method: "GET", url: "/api/topics" });
    expect(topics.json()).toEqual({ topics: [] });
  });

  it("仓库学习档案返回加权掌握度与到期复习数", async () => {
    const { Journal } = await import("../../../../adapter/outbound/persistence/journal.js");
    new Journal(fx.repoDir, fx.repositoryId).append("exercise_result", {
      exercise_id: "ex-fixture", target_unit_id: "llm:custom-source:0", passed: true, score: 1, grading_mode: "rubric", attempt_kind: "first"
    });
    const learner = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/learner` });
    expect(learner.statusCode).toBe(200);
    expect(learner.json()).toMatchObject({
      repositoryId: fx.repositoryId,
      modelVersion: "mastery-v0",
      dueReviews: 0,
      mastery: [{ unitId: "llm:custom-source:0", score: 0.5, level: 1, attempts: 1, successes: 1, confidence: 0.2 }]
    });
  });

  it("遗忘仓库后 contribution 消失", async () => {
    const { learnerStore } = await import("../../../../infrastructure/composition-root.js");
    expect(learnerStore.listContributions({ repositoryId: fx.repositoryId })).toHaveLength(1);
    const forgotten = await fx.app.inject({ method: "DELETE", url: `/api/repositories/${fx.repositoryId}` });
    expect(forgotten.statusCode).toBe(200);
    expect(learnerStore.listContributions({ repositoryId: fx.repositoryId })).toEqual([]);
    const profile = await fx.app.inject({ method: "GET", url: "/api/learner/profile" });
    expect(profile.json()).toMatchObject({ topics: [], stacks: [] });
  });
});
