import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentTracePayloadSchema } from "@codebase-tutor/contract";

import { createRouteFixture, type RouteFixture } from "../controller-test-kit.js";
import { subscribeEvents, unsubscribeEvents } from "../../../../events.js";

/** 练习路由层的拒收用例：题型不支持。沙箱实跑与付费前拒收在 `exercises/` 的用例里。 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("出题轨迹与历史", () => {
  it("取消未在跑的 job 是幂等的：返回 canceled=false，不当失败", async () => {
    const result = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/exercises/job_not_running/cancel` });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ canceled: false });
  });

  it("出题途中取消：请求以 499 结束，journal 记取消，不落题", async () => {
    const proposal = {
      ok: true,
      title: "分析 registerOrder 的注册顺序",
      prompt: "阅读摘录里 registerOrder 的注册步骤，说明先注册什么、后注册什么。",
      answerKey: "先登记构建器，再统一执行。",
      criteria: [{ dimension: "正确性", description: "说清先后顺序" }],
      anchors: [{ path: "src/main.ts", line: 3 }],
      targetTitle: "registerOrder"
    };
    fx.scripted = [JSON.stringify(proposal)];
    fx.holdMs = 5_000;
    const generatedBefore = fx.eventsOf("exercise_generated").length;
    const jobId = "job_cancel_route";
    const pending = fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/exercises`, payload: { kind: "llm_rubric", tag: "registerOrder", tagId: "custom-register-order", jobId } });
    while (fx.fetchCalls() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const canceled = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/exercises/${jobId}/cancel` });
    expect(canceled.json()).toEqual({ canceled: true });
    expect((await pending).statusCode).toBe(499);
    expect(fx.eventsOf("exercise_started").at(-1)?.payload).toMatchObject({ scene: "practice.generate", job_id: jobId, tag: "registerOrder" });
    expect(fx.eventsOf("exercise_aborted").at(-1)?.payload).toMatchObject({ reason: "user_cancel" });
    expect(fx.eventsOf("exercise_generated")).toHaveLength(generatedBefore);
  });

  it("出题把每次模型调用的回复写进 journal，历史回放能读到", async () => {
    const proposal = {
      ok: true,
      title: "分析 registerOrder 的注册顺序",
      prompt: "阅读摘录里 registerOrder 的注册步骤，说明先注册什么、后注册什么。",
      answerKey: "先登记构建器，再统一执行。",
      criteria: [{ dimension: "正确性", description: "说清先后顺序" }],
      anchors: [{ path: "src/main.ts", line: 3 }],
      targetTitle: "registerOrder"
    };
    fx.scripted = [JSON.stringify(proposal)];
    await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/exercises`, payload: { kind: "llm_rubric", tag: "registerOrder", tagId: "custom-register-order" } });
    const reply = fx.eventsOf("exercise_model_reply").at(-1);
    expect(reply, "模型回复要能进历史轨迹").toBeDefined();
    expect(reply?.payload.reply).toContain("分析 registerOrder");
    expect(reply?.payload.reply_truncated).toBe(false);
  });
});

describe("代码题走通练习路由", () => {
  it("旧题型 output_prediction 已从题型闸门里退出：请求它拿 400，而不是静默出另一道题", async () => {
    const refused = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/exercises`, payload: { kind: "output_prediction" } });
    expect(refused.statusCode).toBe(400);
    expect(String((refused.json() as { error: string }).error)).toContain("不支持的练习题型");
  });

  it("主题零词法命中时 422 带公开错误码，界面据此给出改用分析题的出口", async () => {
    const refused = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/exercises`, payload: { type: "comprehension", tag: "操作系统", tagId: "custom-os" } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: "theme_not_found" });
  });

  it("出题这趟发实时轨迹：进行中 → 失败，runId 与 journal 的 traceId 相同", async () => {
    const frames: Record<string, unknown>[] = [];
    subscribeEvents({ connectionId: "exercise-trace-test", send: (event) => { if (event.type === "agent.trace") frames.push(event.payload as Record<string, unknown>); } });
    try {
      const refused = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/exercises`, payload: { type: "comprehension", tag: "操作系统", tagId: "custom-os" } });
      expect(refused.statusCode).toBe(422);
      const starts = frames.filter((frame) => frame.kind === "turn" && frame.status === "start");
      expect(starts).toHaveLength(1);
      expect(agentTracePayloadSchema.safeParse(starts[0]).success).toBe(true);
      expect(starts[0]).toMatchObject({ repositoryId: fx.repositoryId, scene: "practice.generate", label: "出题 · 操作系统" });
      expect(frames.some((frame) => frame.kind === "turn" && frame.status === "error")).toBe(true);
      const declined = fx.eventsOf("exercise_declined").find((event) => event.traceId === starts[0].runId);
      expect(declined, "实时轨迹的 runId 应与 journal 的 traceId 相同").toBeDefined();
    } finally {
      unsubscribeEvents("exercise-trace-test");
    }
  });
});
