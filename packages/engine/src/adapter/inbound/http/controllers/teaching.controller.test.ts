import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteFixture, MAIN_FILE, TAIL, sseEvents, deltasOf, doneEvent, type RouteFixture } from "../controller-test-kit.js";

/** 教学作用域（SSE）：会话即线程，回合正文落库并与 done.message 一致，不变量复检进 journal。 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("教学作用域（SSE）", () => {
  async function openSession(settings?: Record<string, unknown>): Promise<string> {
    const created = await fx.app.inject({ method: "POST", url: "/api/sessions", payload: { repositoryId: fx.repositoryId, scopeRef: `file:${MAIN_FILE}`, ...(settings ? { settings } : {}) } });
    const id = (created.json() as { session: { id: string } }).session.id;
    fx.usedThreads.add(id);
    return id;
  }

  function replyOf(payload: string): { reply: string; events: Record<string, unknown>[] } {
    const events = sseEvents(payload);
    const done = doneEvent(events) as { message: { content: string } };
    return { reply: done.message.content, events };
  }

  it("teach：合格回合 applicable 含两条不变量、无尾注，done.message 与库里正文一致", async () => {
    const sessionId = await openSession();
    fx.scripted = [`registerOrder 在 ${MAIN_FILE}:3 先跑，你觉得少了哪一步会先炸？`];
    const response = await fx.app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "这一节我没看懂" } });
    const { reply, events } = replyOf(response.payload);

    const invariant = fx.lastEvent("turn_invariant");
    expect(invariant.payload.scene).toBe("teach");
    const applicable = String(invariant.payload.applicable);
    expect(applicable).toContain("reference-grounding");
    expect(applicable).toContain("anchor-binding");
    expect(applicable).not.toContain("socratic-question");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(invariant.sessionId).toBe(sessionId);

    expect(reply).not.toContain(TAIL);
    expect(deltasOf(events)).toBe(reply);
    expect(fx.assistantMessage(sessionId).content).toBe(reply);
    expect(fx.lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("teach：假引用失守，尾注进正文也进库里那一份", async () => {
    const sessionId = await openSession();
    fx.scripted = ["直接讲结论，registerOrder 的作用与 src/missing.ts:1 无关。"];
    const response = await fx.app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "再讲一遍" } });
    const { reply, events } = replyOf(response.payload);

    const failed = String(fx.lastEvent("turn_invariant").payload.failed);
    expect(failed).toContain("reference-grounding");

    expect(reply).toContain(TAIL);
    expect(deltasOf(events)).toBe(reply);
    expect(fx.assistantMessage(sessionId).content).toBe(reply);
    expect(fx.lastEvent("turn_text").payload.answer).toBe(reply);
  });

  it("teach：引用与点名标识符两条都判（这一档是问答域的设计承诺）", async () => {
    const sessionId = await openSession({});
    const answer = `这一步就是把请求交给 OrderRegistry 注册，你先看 ${MAIN_FILE}:3 那一行？`;
    fx.scripted = [answer];
    const response = await fx.app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "换个说法" } });
    const { reply } = replyOf(response.payload);

    const invariant = fx.lastEvent("turn_invariant");
    const applicable = String(invariant.payload.applicable);
    expect(applicable).toContain("reference-grounding");
    expect(applicable).toContain("anchor-binding");
    expect(invariant.payload.failed ?? null).toBe(null);
    expect(reply).toBe(answer);
  });
});

describe("LLM 工作日志的账面一致性", () => {
  it("每次 provider 调用追加一行，threadId 与本文件用过的线程全等，失败只允许是中止", async () => {
    await fx.verifyLlmLog({ expectAborted: false, scenes: ["teaching.turn"] });
  });
});
