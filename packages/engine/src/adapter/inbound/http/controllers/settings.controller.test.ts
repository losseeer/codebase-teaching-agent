import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { createRouteFixture, type RouteFixture } from "../controller-test-kit.js";
import { defaultMonthlyBudgetUsd } from "../../../../cost/cost.js";

/** 预算闸门：已达上限时付费分支不放行，只读路由照旧免费。 */
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
    // 闸门判「已花 ≥ 预算」，0 预算未花也判 degraded
    expect(closedBody.mode).toBe("degraded");

    const callsBefore = fx.fetchCalls();
    const refused = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/exercises`, payload: { family: "llm", tag: "依赖注入" } });
    expect(refused.statusCode).toBe(422);
    expect(String((refused.json() as { error: string }).error)).toContain("预算");
    expect(fx.fetchCalls(), "达到预算上限后不该把请求打到模型上").toBe(callsBefore);

    // 对照组：预算不是 0 时闸门放行
    const reopened = await fx.app.inject({ method: "PUT", url: `/api/repositories/${fx.repositoryId}/settings`, payload: { monthlyBudgetUsd: defaultMonthlyBudgetUsd } });
    expect((reopened.json() as { mode: string }).mode).toBe("normal");
  });

  /** 问答回合与 map/practice 共用同一条闸门：达到上限时在发请求前 422。 */
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
    // 没开火就不记账
    expect(fx.eventsOf("token_usage").filter((event) => event.sessionId === sessionId)).toEqual([]);
    expect(fx.eventsOf("turn_text").filter((event) => event.sessionId === sessionId)).toEqual([]);
  });

  /** 闸门值是本 describe 唯一的共享状态，必须在 afterEach 还原。 */
  afterEach(async () => {
    await fx.app.inject({ method: "PUT", url: `/api/repositories/${fx.repositoryId}/settings`, payload: { monthlyBudgetUsd: defaultMonthlyBudgetUsd } });
  });
});

describe("请求超时的运行时旋钮", () => {
  /** 超时档位改完即时生效，留空回到 `.env` 那一份。 */
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
