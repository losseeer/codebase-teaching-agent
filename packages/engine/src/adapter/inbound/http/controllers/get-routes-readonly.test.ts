import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteFixture, MAIN_FILE, OK_REPLY, type RouteFixture } from "../controller-test-kit.js";

/** 读侧不发模型请求：路由树里每条 GET 都用真参数走一遍，假 provider 调用数为 0。
    清单从 Fastify 路由树现取；条数设下限，并有控制组证明计数器会动。 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

/** find-my-way 的打印树用四格缩进（`    `、`│   `、`├── `、`└── `），段名可能带 `(GET, HEAD)` 后缀。 */
const PREFIX = /^(?:(?: {4})|(?:│ {3})|(?:├── )|(?:└── ))*/;

function getRoutePaths(): string[] {
  const stack: string[] = [];
  const paths: string[] = [];
  for (const row of fx.app.printRoutes().split("\n").slice(1)) {
    const indent = PREFIX.exec(row)?.[0] ?? "";
    const depth = indent.length / 4;
    const body = row.slice(indent.length);
    if (!body) continue;
    const methods = /\(([^)]*)\)\s*$/.exec(body);
    stack[depth] = methods ? body.slice(0, methods.index).trimEnd() : body;
    stack.length = depth + 1;
    if ((methods?.[1] ?? "").split(",").some((method) => method.trim().toUpperCase() === "GET")) paths.push(stack.slice(0, depth + 1).join(""));
  }
  return paths;
}

describe("GET 路由全部只读", () => {
  /** 事件流是长连接，`inject` 不返回，故排除在外。 */
  const LONG_LIVED = new Set(["/api/events"]);

  it("路由树里每条 GET 都走一遍：provider 调用计数为 0", async () => {
    const created = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/diagrams`, payload: { name: "守卫用" } });
    const diagramId = (created.json() as { diagram: { id: string } }).diagram.id;
    const threadId = await fx.newThread("map", "守卫用");
    const queries: Record<string, string> = {
      "/api/repositories/:repositoryId/source": `?path=${encodeURIComponent(MAIN_FILE)}&line=1`,
      "/api/repositories/:repositoryId/threads": "?scope=map",
      "/api/repositories/:repositoryId/cost": `?sessionId=${threadId}`
    };

    const paths = getRoutePaths();
    expect(paths.length, "只解析出这么几条 GET：解析器与 Fastify 的输出脱钩了，这条断言会变成假绿").toBeGreaterThanOrEqual(15);

    const walked: string[] = [];
    for (const path of paths) {
      if (LONG_LIVED.has(path)) continue;
      const url = path
        .replace(":repositoryId", fx.repositoryId)
        .replace(":diagramId", diagramId)
        .replace(":threadId", threadId)
        .replace(":sessionId", threadId)
        .replace(":jobId", "job_not_running") + (queries[path] ?? "");
      const response = await fx.app.inject({ method: "GET", url });
      walked.push(`${url} → ${response.statusCode}`);
      expect(response.statusCode, `GET ${url} 抛错：读路由也要能对上真参数清单\n${walked.join("\n")}`).toBeLessThan(500);
    }
    expect(walked.length, "覆盖面：除长连接之外的每条 GET 都要真走过").toBe(paths.length - LONG_LIVED.size);
    expect(fx.sentTools.length, `有读路由开火了（逐条状态见下）：\n${walked.join("\n")}`).toBe(0);
  });

  it("控制组：同一条对话路径确实会让计数动起来", async () => {
    fx.scripted = [OK_REPLY];
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/map-chat/stream`, payload: { content: "这仓分几层？" } });
    expect(response.statusCode).toBe(200);
    expect(fx.sentTools.length).toBeGreaterThan(0);
  });
});
