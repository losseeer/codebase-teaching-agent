import { describe, expect, it, vi } from "vitest";

import { INTERNAL_REGISTRY, ToolRegistry } from "./registry.js";
import { AUTO_SCHEMA_BUDGET, INLINE_INDEX_LIMIT, exposeTools, toolIndexBrief } from "./exposure.js";
import { catalogOf } from "./catalog.js";
import { ToolInvoker } from "./invoker.js";
import type { ToolContext, ToolDefinition, ToolGroup } from "./types.js";

/** 暴露、目录与调用：不请求模型，只走注册表与调用器。 */

function tool(name: string, options: { exposure?: ToolDefinition["exposure"]; schemaChars?: number; required?: boolean; spy?: () => void } = {}): ToolDefinition {
  return {
    name,
    summary: `${name} 的用途`,
    schema: {
      type: "object",
      properties: {
        ...(options.required ? { path: { type: "string" } } : {}),
        ...(options.schemaChars ? { pad: { type: "string", description: "x".repeat(options.schemaChars) } } : {})
      },
      ...(options.required ? { required: ["path"] } : {})
    },
    exposure: options.exposure ?? "always",
    effect: "read",
    origin: { kind: "internal" },
    invoke: (args) => {
      options.spy?.();
      return { text: `${name}:${JSON.stringify(args)}` };
    }
  };
}

function group(tools: ToolDefinition[]): ToolGroup {
  return { id: "probe", summary: "探针", scope: "all", available: () => true, tools };
}

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({ scope: "map", ...overrides });

function invokerFor(tools: ToolDefinition[], context: ToolContext) {
  const registry = new ToolRegistry([group(tools)]);
  const exposure = exposeTools(registry, context);
  const withCatalog: ToolContext = { ...context };
  withCatalog.catalog = catalogOf(exposure.onDemand, (name) => registry.find(name, withCatalog));
  return { registry, exposure, context: withCatalog, invoker: new ToolInvoker(registry, exposure) };
}

describe("注册表的过滤", () => {
  const map = ctx({ repoPath: "/tmp/repo", search: undefined, ask: { facets: ["range"] }, diagram: { apply: () => "ok" }, facts: { apply: () => "ok" } });

  it("工作区与可用性一起判：map 有图与提问，practice 没有", () => {
    const names = (context: ToolContext) => INTERNAL_REGISTRY.entries(context).map((entry) => entry.definition.name);
    expect(names(map)).toEqual(["read_file", "ask_user", "set_diagram", "query_facts"]);
    expect(names({ ...map, scope: "practice" })).toEqual(["read_file", "query_facts"]);
  });

  it("通道缺席就不暴露，但仍知道这个名字", () => {
    const bare = ctx();
    expect(INTERNAL_REGISTRY.entries(bare).map((entry) => entry.definition.name)).toEqual([]);
    expect(INTERNAL_REGISTRY.known("read_file")?.name).toBe("read_file");
  });

  it("检索与静态产物按通道给，不按工作区写死", () => {
    const search = { entries: [] } as unknown as ToolContext["search"];
    const names = INTERNAL_REGISTRY.entries(ctx({ scope: "practice", repoPath: "/tmp/repo", search, facts: { apply: () => "ok" } })).map((entry) => entry.definition.name);
    expect(names).toEqual(["read_file", "search_code", "query_facts"]);
  });
});

describe("暴露层", () => {
  it("auto 工具 schema 总量在预算内就常驻，超过就收进按需目录", () => {
    const small = exposeTools(new ToolRegistry([group([tool("mcp__srv__a", { exposure: "auto", schemaChars: 10 })])]), ctx());
    expect(small.always.map((definition) => definition.name)).toEqual(["mcp__srv__a"]);
    expect(small.onDemand).toEqual([]);

    const big = exposeTools(new ToolRegistry([group([tool("mcp__srv__a", { exposure: "auto", schemaChars: AUTO_SCHEMA_BUDGET })])]), ctx());
    expect(big.onDemand.map((entry) => entry.name)).toEqual(["mcp__srv__a"]);
    expect(big.always.map((definition) => definition.name)).toEqual(["tool_inspect", "tool_call"]);
    expect(toolIndexBrief(big), "目录不大时直接内联进 system").toContain("mcp__srv__a");
  });

  it("目录超过内联上限才加 tool_search；否则只给 inspect 与 call", () => {
    const many = Array.from({ length: INLINE_INDEX_LIMIT + 1 }, (_, index) => tool(`t${index}`, { exposure: "on-demand" }));
    const wide = exposeTools(new ToolRegistry([group(many)]), ctx());
    expect(wide.always.map((definition) => definition.name)).toEqual(["tool_inspect", "tool_call", "tool_search"]);
    expect(toolIndexBrief(wide)).toContain("先调用 tool_search");

    const narrow = exposeTools(new ToolRegistry([group(many.slice(0, INLINE_INDEX_LIMIT))]), ctx());
    expect(narrow.always.map((definition) => definition.name)).not.toContain("tool_search");
  });

  it("同一回合里 tools 数组与目录只算一次（纯函数，输入不变输出不变）", () => {
    const registry = new ToolRegistry([group([tool("t0", { exposure: "on-demand" })])]);
    const first = exposeTools(registry, ctx());
    const second = exposeTools(registry, ctx());
    expect(first).toEqual(second);
  });
});

describe("调用器", () => {
  it("按需工具要经 tool_inspect 看参数、再经 tool_call 执行；直接点名会被挡回", async () => {
    const { invoker, context } = invokerFor([tool("mcp__srv__lookup", { exposure: "on-demand" })], ctx());
    const direct = await invoker.invoke({ id: "c1", name: "mcp__srv__lookup", argumentsJson: "{}" }, context);
    expect(direct.outcome.text).toContain("按需工具");
    expect(direct.outcome.ok).toBe(false);

    const inspect = await invoker.invoke({ id: "c2", name: "tool_inspect", argumentsJson: JSON.stringify({ name: "mcp__srv__lookup" }) }, context);
    expect(JSON.parse(inspect.outcome.text)).toMatchObject({ name: "mcp__srv__lookup", effect: "read" });

    const executed = await invoker.invoke({ id: "c3", name: "tool_call", argumentsJson: JSON.stringify({ name: "mcp__srv__lookup", arguments: { q: "x" } }) }, context);
    expect(executed.outcome.text).toBe('mcp__srv__lookup:{"q":"x"}');
  });

  it("schema 校验挡在调用之前：参数不全不执行，回一句模型看得懂的错", async () => {
    const spy = vi.fn();
    const { invoker, context } = invokerFor([tool("probe", { required: true, spy })], ctx());
    const outcome = await invoker.invoke({ id: "c1", name: "probe", argumentsJson: "{}" }, context);
    expect(outcome.outcome.ok).toBe(false);
    expect(outcome.outcome.text).toContain("schema");
    expect(outcome.outcome.text).toContain("path");
    expect(spy, "校验没过就不能有副作用").not.toHaveBeenCalled();
  });

  it("额度守卫在看 schema 之后、真正执行之前：回绝句原样进消息，轨迹记 error", async () => {
    const spy = vi.fn();
    const { invoker, context } = invokerFor([tool("probe", { spy })], ctx());
    const steps: { status: string }[] = [];
    const outcome = await invoker.invoke({ id: "c1", name: "probe", argumentsJson: "{}" }, context, { round: 1, onTrace: (step) => steps.push(step) }, () => "额度已经用完。");
    expect(outcome.outcome.text).toBe("额度已经用完。");
    expect(spy).not.toHaveBeenCalled();
    expect(steps.map((step) => step.status)).toEqual(["start", "error"]);
  });

  it("已知但当前不可用的工具说实话；不认识的才叫未知", async () => {
    const context = ctx();
    const invoker = new ToolInvoker(INTERNAL_REGISTRY, exposeTools(INTERNAL_REGISTRY, context));
    const known = await invoker.invoke({ id: "c1", name: "ask_user", argumentsJson: JSON.stringify({ facet: "range", question: "画哪一块？", options: ["整仓"] }) }, context);
    expect(known.outcome.text).toContain("没有向用户提问的通道");
    const unknown = await invoker.invoke({ id: "c2", name: "write_file", argumentsJson: "{}" }, context);
    expect(unknown.outcome.text).toContain("未知工具 write_file");
  });

  it("目录搜索按名字、摘要与分组命中", async () => {
    const lookup = tool("mcp__srv__lookup", { exposure: "on-demand" });
    const filler = Array.from({ length: INLINE_INDEX_LIMIT }, (_, index) => tool(`filler${index}`, { exposure: "on-demand" }));
    const { invoker, context } = invokerFor([lookup, ...filler], ctx());
    const hit = await invoker.invoke({ id: "c1", name: "tool_search", argumentsJson: JSON.stringify({ query: "lookup" }) }, context);
    expect(hit.outcome.text).toContain("mcp__srv__lookup");
    const miss = await invoker.invoke({ id: "c2", name: "tool_search", argumentsJson: JSON.stringify({ query: "没有这个" }) }, context);
    expect(miss.outcome.ok).toBe(false);
  });
});
