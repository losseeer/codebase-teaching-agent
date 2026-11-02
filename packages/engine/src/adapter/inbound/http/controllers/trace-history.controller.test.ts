import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { traceHistorySchema } from "@codebase-tutor/contract";

import { createRouteFixture, OK_REPLY, type RouteFixture } from "../controller-test-kit.js";
import { subscribeEvents, unsubscribeEvents } from "../../../../events.js";

/** 历史回放：实时帧的 runId 与 journal 的 traceId 对齐，读侧不发模型。 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("GET /trace 的 journal 回放", () => {
  it("刚跑完的回合按 traceId 还原；实时帧用同一个 runId", async () => {
    const frames: Record<string, unknown>[] = [];
    subscribeEvents({ connectionId: "trace-history-test", send: (event) => { if (event.type === "agent.trace") frames.push(event.payload); } });
    try {
      fx.scripted = ['@@tool read_file {"path":"src/main.ts"}', OK_REPLY];
      const threadId = await fx.newThread("map", "历史回放");
      const turn = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: "这个模块从哪里开始看？", threadId } });
      expect(turn.statusCode).toBe(200);

      const traceId = fx.lastEvent("turn_text").traceId;
      expect(traceId).toBeTruthy();
      expect(frames.find((frame) => frame.kind === "turn" && frame.status === "start")?.runId, "实时帧与 journal 用同一个键，历史和实时才能去重").toBe(traceId);

      const before = fx.fetchCalls();
      const response = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/trace?limit=5` });
      expect(response.statusCode).toBe(200);
      expect(fx.fetchCalls(), "历史读取不发模型").toBe(before);

      const history = traceHistorySchema.parse(response.json());
      expect(history.runs).toHaveLength(1);
      const run = history.runs[0];
      expect(run).toMatchObject({ runId: traceId, scene: "map.chat", threadId, status: "ok" });
      expect(run.summary).toContain("读 1 个文件");
      const tools = run.steps.filter((step) => step.kind === "tool");
      expect(tools.map((step) => step.tool)).toEqual(["read_file"]);
      expect(tools[0]).toMatchObject({ status: "ok" });
      expect(tools[0].label).toContain("src/main.ts");
      expect(run.steps.find((step) => step.kind === "model")?.inputTokens).toBeGreaterThan(0);
      expect(run.steps.find((step) => step.kind === "turn")?.label).toContain("这个模块");

      const practice = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/trace?limit=5&scope=practice` });
      expect(traceHistorySchema.parse(practice.json()).runs, "别的作用区不该出现在当前作用区的历史里").toHaveLength(0);
    } finally {
      unsubscribeEvents("trace-history-test");
    }
  });
});
