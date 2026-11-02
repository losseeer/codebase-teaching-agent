import type { ToolCatalog, ToolDefinition } from "./types.js";

/** 按需目录的入口工具：搜索、查看参数、执行。schema 固定。 */

const MAX_LIMIT = 20;

export const TOOL_SEARCH_DEFINITION: ToolDefinition = {
  name: "tool_search",
  summary: "在当前轮按需工具里搜索；query 省略时列出全部。",
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "按名字、摘要、标签或分组搜索" },
      limit: { type: "integer", description: `返回条数上限，默认 10，最多 ${MAX_LIMIT}` }
    },
    required: []
  },
  exposure: "always",
  effect: "read",
  origin: { kind: "internal" },
  scope: "all",
  describe: () => ({ label: "搜索工具" }),
  invoke: (args, ctx) => {
    const catalog = ctx.catalog;
    if (!catalog) return { text: "这一轮没有按需工具。", ok: false };
    const query = stringArg(args, "query").toLowerCase();
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number((args as { limit?: unknown } | null)?.limit) || 10));
    const hits = catalog.entries.filter((entry) => !query || [entry.name, entry.summary, entry.group, ...(entry.tags ?? [])].some((value) => value.toLowerCase().includes(query))).slice(0, limit);
    if (!hits.length) return { text: `没有匹配「${query}」的按需工具。`, ok: false };
    return { text: hits.map((entry) => `${entry.name}：${entry.summary}（${entry.group}）`).join("\n") };
  }
};

export const TOOL_INSPECT_DEFINITION: ToolDefinition = {
  name: "tool_inspect",
  summary: "查看一个按需工具的完整参数、示例与返回形状。",
  schema: {
    type: "object",
    properties: { name: { type: "string", description: "按需工具名" } },
    required: ["name"]
  },
  exposure: "always",
  effect: "read",
  origin: { kind: "internal" },
  scope: "all",
  describe: (args) => ({ label: `查看工具 ${stringArg(args, "name")}`.trim() }),
  invoke: (args, ctx) => {
    const name = stringArg(args, "name");
    const definition = ctx.catalog?.find(name);
    if (!definition || !ctx.catalog?.entries.some((entry) => entry.name === name)) return { text: `没有按需工具「${name}」。`, ok: false };
    const info = definition.inspect?.() ?? {
      name: definition.name,
      summary: definition.summary,
      schema: definition.schema,
      ...(definition.examples ? { examples: definition.examples } : {}),
      ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
      ...(definition.version ? { version: definition.version } : {}),
      effect: definition.effect,
      origin: definition.origin
    };
    return { text: JSON.stringify(info, null, 2) };
  }
};

export const TOOL_CALL_DEFINITION: ToolDefinition = {
  name: "tool_call",
  summary: "执行一个按需工具；先用 tool_inspect 看参数。",
  schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "按需工具名" },
      arguments: { type: "object", description: "该工具的参数对象" }
    },
    required: ["name", "arguments"]
  },
  exposure: "always",
  effect: "read",
  origin: { kind: "internal" },
  scope: "all",
  describe: (args) => ({ label: `按需调用 ${stringArg(args, "name")}`.trim() }),
  // 由 ToolInvoker 解包执行；直接调用只可能是装配错误。
  invoke: () => ({ text: "tool_call 只由调用器执行。", ok: false })
};

/** 本轮按需目录。 */
export function catalogOf(entries: ToolCatalog["entries"], find: ToolCatalog["find"]): ToolCatalog {
  return { entries, find };
}

function stringArg(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value.trim() : "";
}
