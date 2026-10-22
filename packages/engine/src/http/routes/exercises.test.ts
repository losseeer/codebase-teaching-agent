import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteFixture, type RouteFixture } from "./route-test-kit.js";

/**
  练习路由这一层的闸门读数：题型拒收。
  出题与判分的沙箱实跑住在 `exercises/code-generate.test.ts`，「沙箱不可用要在付费前拒」住在 `exercises/exercises.test.ts`。
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
