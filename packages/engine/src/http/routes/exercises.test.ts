import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteFixture, type RouteFixture } from "./route-test-kit.js";

/**
  代码题从出题到判分走完整路由：沙箱真跑、判分不落模型，出网与审计各自留痕。
 */
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
});

/**
  预算闸门对**付费分支**的放行口径：`monthlyBudgetUsd` 是这产品唯一的省钱开关，调小却不拦就是
  账单照着「没预算」的样子继续走（同族事故：闸门判据散在几处、各写各的，改一处漏一处）。
  这条放在文件末尾，因为它改的是**落库预算**——前面的用例都按默认预算跑；
  全程零 token：被拒的那一支根本不该打到模型上，靠 `fx.fetchCalls()` 不增加来硬性约束。
  */