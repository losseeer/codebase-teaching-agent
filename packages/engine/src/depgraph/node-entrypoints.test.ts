import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph } from "@codebase-tutor/analysis";
import { isServedEntrypoint } from "@codebase-tutor/analysis";
import { loadSymbolParser } from "@codebase-tutor/analysis";

const nodeFixture = join(dirname(fileURLToPath(import.meta.url)), "../../../../test-fixtures/nodedemo-repo");

describe("Node/TS 框架入口（Express / Fastify / Koa / Nest）", () => {
  it("四份真形态各认一条服务入口，锚点落在证据行", async () => {
    await loadSymbolParser();
    const index = indexRepository(nodeFixture);
    const graph = buildDependencyGraph(nodeFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "fastifyapp/server.ts", line: 6, label: "HTTP 路由 (Fastify)" });
    expect(graph.entrypoints).toContainEqual({ path: "expressshop/routes/orders.ts", line: 6, label: "HTTP 路由 (Express)" });
    expect(graph.entrypoints).toContainEqual({ path: "nestshop/orders/orders.controller.ts", line: 6, label: "HTTP 路由 (NestJS)" });
    // 启动语句缩在函数里也算证据：那行是真代码
    expect(graph.entrypoints).toContainEqual({ path: "legacy/serve.ts", line: 8, label: "HTTP 服务启动 (Express)" });
    // 认出来的四条全是「外部会打到它」那一类：架构视图的 entry 档位与模块分级都靠这个判定
    expect(graph.entrypoints.filter(isServedEntrypoint)).toHaveLength(4);
    // 一个文件只留一条：`fastifyapp/server.ts` 既有路由又有 listen，不能变成两条入口
    expect(graph.entrypoints.filter((item) => item.path === "fastifyapp/server.ts")).toHaveLength(1);
  });

  it("负例：客户端调用、注释里的示例、模板字符串里的假源码、纯工具文件都不算入口", async () => {
    await loadSymbolParser();
    const index = indexRepository(nodeFixture);
    const graph = buildDependencyGraph(nodeFixture, index.files);
    const paths = graph.entrypoints.map((item) => item.path);
    // axios 的 api.get("/orders") 与路由登记长得一模一样，但它是打别人的那一方
    expect(paths).not.toContain("client/orders-api.ts");
    // 演示数据把一份假的后端源码整段写入模板字符串：逐行看都是证据，只有语法树知道那不是代码
    expect(paths).not.toContain("docs/demo-data.ts");
    expect(paths).not.toContain("library/format.ts");
    expect([...paths].sort()).toEqual([
      "expressshop/routes/orders.ts",
      "fastifyapp/server.ts",
      "legacy/serve.ts",
      "nestshop/orders/orders.controller.ts"
    ]);
  });
});
