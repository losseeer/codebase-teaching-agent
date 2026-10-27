import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { createRouteFixture, type RouteFixture } from "../controller-test-kit.js";
import { defaultMonthlyBudgetUsd } from "../../../../cost/cost.js";

/**
  预算闸门：已达上限时付费分支一律不放行（出题、推荐入口、流程重问各回一句各自的原因），只读路由照旧免费。
 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("预算已达上限时不放行付费分支", () => {
  it("预算 0 ⇒ LLM 出题被拒且一次模型调用都没发生；把预算调回去闸门就翻回放行", async () => {
    const closed = await fx.app.inject({ method: "PUT", url: `/api/repositories/${fx.repositoryId}/settings`, payload: { monthlyBudgetUsd: 0 } });
    expect(closed.statusCode).toBe(200);
    const closedBody = closed.json() as { mode: string; settings: { monthlyBudgetUsd: number } };
    expect(closedBody.settings.monthlyBudgetUsd, "预算 0 要如实回读，不能被当成「没给」而回落默认").toBe(0);
    // 0 预算、一分钱没花仍是 degraded：闸门判的是「已花 ≥ 预算」，不是「还剩很多」
    expect(closedBody.mode).toBe("degraded");

    const callsBefore = fx.fetchCalls();
    const refused = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/exercises`, payload: { family: "llm", tag: "依赖注入" } });
    expect(refused.statusCode).toBe(422);
    expect(String((refused.json() as { error: string }).error)).toContain("预算");
    expect(fx.fetchCalls(), "达到预算上限后不该把请求打到模型上").toBe(callsBefore);

    // 对照组：同一套运行时设置、只是预算不是 0 ⇒ 闸门翻回放行（证明上面那句 422 来自闸门，不是「没配模型」）
    const reopened = await fx.app.inject({ method: "PUT", url: `/api/repositories/${fx.repositoryId}/settings`, payload: { monthlyBudgetUsd: defaultMonthlyBudgetUsd } });
    expect((reopened.json() as { mode: string }).mode).toBe("normal");
  });

  /**
    问答回合与 map/practice 共用同一条闸门：达到预算上限时在发请求之前就 422，不回本地兜底文案。
    所以这一轮的账面是「什么都没发生」。
    */
  it("teach 达到预算上限回合：拒在开火前，一次模型调用都不打、一行账都不记", async () => {
    const closed = await fx.app.inject({ method: "PUT", url: `/api/repositories/${fx.repositoryId}/settings`, payload: { monthlyBudgetUsd: 0 } });
    expect((closed.json() as { mode: string }).mode).toBe("degraded");
    const created = await fx.app.inject({ method: "POST", url: "/api/sessions", payload: { repositoryId: fx.repositoryId, scopeRef: "file:src/main.ts" } });
    const sessionId = (created.json() as { session: { id: string } }).session.id;

    const callsBefore = fx.fetchCalls();
    const response = await fx.app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "这一节我没看懂" } });
    expect(response.statusCode).toBe(422);
    expect(String((response.json() as { error: string }).error)).toContain("预算");
    expect(fx.fetchCalls(), "达到预算上限后这一轮不该打到模型上").toBe(callsBefore);
    // 没开火就没有账：这一轮既不进 token_usage 也不进 turn_text，成本页的「计费回合」不必再减降级行
    expect(fx.eventsOf("token_usage").filter((event) => event.sessionId === sessionId)).toEqual([]);
    expect(fx.eventsOf("turn_text").filter((event) => event.sessionId === sessionId)).toEqual([]);
  });

  /**
    闸门值是这个 describe 唯一的共享状态：每条用例跑完都还回默认预算。
    还原必须放在 afterEach——放在用例末尾时，中间任何一条断言先红就会跳过还原，
    后面的 teach/map 用例会整片变成 422。
    */
  afterEach(async () => {
    await fx.app.inject({ method: "PUT", url: `/api/repositories/${fx.repositoryId}/settings`, payload: { monthlyBudgetUsd: defaultMonthlyBudgetUsd } });
  });
});

describe("请求超时的运行时旋钮", () => {
  /**
    这一档原本只能改 `.env` 再重启，而模型侧那句「推理模型较慢时可以调大超时时长」一直在指它——
    说得出却动不了的旋钮等于没有。慢的读数是真的：本机一次 map.chat 的第二发常见 30~60 秒，
    60 秒一发加一发重试会把正常回合判成失败。
    */
  it("PUT 合法值立刻生效，留空回到 .env 那一份", async () => {
    const before = (await fx.app.inject({ method: "GET", url: "/api/llm/settings" })).json() as { timeoutMs?: string; activeTimeoutMs?: number; timeoutRange?: { minMs: number; maxMs: number } };
    expect(before.activeTimeoutMs, "没填时生效的是 .env/默认那一份").toBeGreaterThan(0);
    expect(before.timeoutRange?.maxMs, "区间随设置一起下发，界面的说法与判据同源").toBe(300_000);

    const raised = await fx.app.inject({ method: "PUT", url: "/api/llm/settings", payload: { timeoutMs: "180000" } });
    expect(raised.statusCode).toBe(200);
    const raisedBody = raised.json() as { timeoutMs: string; activeTimeoutMs: number };
    expect(raisedBody.timeoutMs).toBe("180000");
    expect(raisedBody.activeTimeoutMs, "改完不用重启：这一格就是下一次请求真正用的值").toBe(180_000);

    const cleared = await fx.app.inject({ method: "PUT", url: "/api/llm/settings", payload: { timeoutMs: "" } });
    expect((cleared.json() as { activeTimeoutMs: number }).activeTimeoutMs).toBe(before.activeTimeoutMs);
  });

  it("越界或读不出数字就当场拒，不改内存态", async () => {
    const before = (await fx.app.inject({ method: "GET", url: "/api/llm/settings" })).json() as { activeTimeoutMs: number };
    for (const raw of ["999999", "500", "abc", "-1"]) {
      const refused = await fx.app.inject({ method: "PUT", url: "/api/llm/settings", payload: { timeoutMs: raw } });
      expect(refused.statusCode, `${raw} 不是合法超时`).toBe(422);
      expect((refused.json() as { reason: string }).reason).toBe("timeout_invalid");
    }
    const after = (await fx.app.inject({ method: "GET", url: "/api/llm/settings" })).json() as { activeTimeoutMs: number };
    expect(after.activeTimeoutMs, "拒掉的值不能留下来生效").toBe(before.activeTimeoutMs);
  });
});
