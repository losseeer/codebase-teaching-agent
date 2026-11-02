import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentTracePayloadSchema } from "@codebase-tutor/contract";

import { createRouteFixture, type RouteFixture } from "../controller-test-kit.js";
import { subscribeEvents, unsubscribeEvents } from "../../../../events.js";

/** 练习路由层的拒收用例：题型不支持。沙箱实跑与付费前拒收在 `exercises/` 的用例里。 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

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
