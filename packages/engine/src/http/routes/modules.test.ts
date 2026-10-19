import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteFixture, MAIN_FILE, type RouteFixture } from "./route-test-kit.js";

/**
  模块路由那组：覆盖层的读写与推荐入口的文档过滤。
  共用判据：覆盖层读时叠加、读侧永不发请求；推荐入口是这组唯一会花钱的路径。
*/
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("覆盖层", () => {
  it("写进去后 /course 看得见，撤掉之后回到引擎原判的那一档", async () => {
    const patched = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/overlays`, payload: { modules: { tier: { "module:src": "core" } } } });
    expect(patched.statusCode).toBe(200);
    const body = patched.json() as { overlays: { modules?: { tier?: Record<string, string> } }; counts: { modules: number } };
    expect(body.overlays.modules?.tier?.["module:src"]).toBe("core");
    expect(body.counts).toEqual({ modules: 1 });

    const course = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/course` })).json() as { root: { children: { id: string; children: { id: string; tier?: string }[] }[] } };
    const src = course.root.children.find((node) => node.id === "modules")!.children.find((node) => node.id === "module:src")!;
    expect(src.tier, "人工改的档要出现在这条出口上").toBe("core");

    const removed = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/overlays`, payload: { remove: { modules: { tier: ["module:src"] } } } });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { counts: unknown }).counts).toEqual({ modules: 0 });
    const read = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/overlays` })).json() as { overlays: { modules?: { tier?: Record<string, string> } } };
    expect(read.overlays.modules?.tier ?? {}, "撤档要真删掉那条记录，不能留个空值").not.toHaveProperty("module:src");
  });
});

describe("推荐入口：文档不进候选清单", () => {
  it("文档在课程树上、却不在出网载荷里；模型回推它的 id 也不会被路由复活", async () => {
    const tree = (await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/course` })).payload;
    expect(tree, "前提：fixture 里得有那个文档节点，否则下面的「不含」是空的通过").toContain("docs/design.md");

    const outboundBefore = fx.sentTools.length;
    fx.scripted = ['["design"]', '[{"id":"unit-doc","reason":"设计文档正是主题入口"},{"id":"unit-1","reason":"实现主干"}]'];
    const response = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/module-entries?module=${encodeURIComponent("设计文档")}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { entries: { id: string; path: string }[]; source: string };
    // 模型推了文档 id：候选池子里没有它，路由只返回代码那条，不替它把文档复活
    expect(body.entries.map((entry) => entry.id)).toEqual(["unit-1"]);
    expect(body.source).toBe("llm");

    const outbound = fx.sentTools.slice(outboundBefore).map((call) => call.raw).join("\n");
    expect(outbound, "文档连候选都不是：不该进过一次出网载荷").not.toContain("docs/design.md");
    expect(outbound).toContain(MAIN_FILE);
    // 翻译层的词表同样来自池子：文档路径切出来的 design/md 不该进 repoVocabulary
    expect(fx.sentTools.slice(outboundBefore)[0].raw).not.toContain('"md"');
  });
});

describe("LLM 工作日志的账面一致性", () => {
  it("每次 provider 调用追加一行，threadId 与本文件用过的线程全等，失败只允许是中止", async () => {
    await fx.verifyLlmLog({ expectAborted: false, scenes: undefined });
  });
});
