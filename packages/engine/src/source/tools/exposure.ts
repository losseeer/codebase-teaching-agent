import type { ToolContext, ToolDefinition, ToolExposure, ToolIndexEntry, ToolRegistryLike } from "./types.js";
import { TOOL_CALL_DEFINITION, TOOL_INSPECT_DEFINITION, TOOL_SEARCH_DEFINITION } from "./catalog.js";

/**
  暴露层：按工作区与可用性过滤，再按 schema 体积决定 auto 工具常驻还是收进目录。
  纯函数；同一回合只算一次，tools 数组不在中途变化。
*/

/** auto 工具的 schema 总字符预算；超过就转按需。 */
export const AUTO_SCHEMA_BUDGET = 8_000;
/** 目录条目不超过这个数就把索引内联进 system，不再强制先调 tool_search。 */
export const INLINE_INDEX_LIMIT = 24;

export function exposeTools(registry: ToolRegistryLike, ctx: ToolContext): ToolExposure {
  const entries = registry.entries(ctx);
  const autoEntries = entries.filter((entry) => entry.definition.exposure === "auto");
  const autoChars = autoEntries.reduce((sum, entry) => sum + JSON.stringify(entry.definition.schema).length, 0);
  const autoOnDemand = autoChars > AUTO_SCHEMA_BUDGET;
  const always: ToolDefinition[] = [];
  const onDemand: ToolIndexEntry[] = [];
  for (const entry of entries) {
    const definition = entry.definition;
    const collect = definition.exposure === "on-demand" || (definition.exposure === "auto" && autoOnDemand);
    if (collect) {
      onDemand.push({
        name: definition.name,
        summary: definition.summary,
        ...(definition.tags ? { tags: definition.tags } : {}),
        group: entry.group.id
      });
    } else {
      always.push(definition);
    }
  }
  if (onDemand.length) {
    always.push(TOOL_INSPECT_DEFINITION, TOOL_CALL_DEFINITION);
    if (onDemand.length > INLINE_INDEX_LIMIT) always.push(TOOL_SEARCH_DEFINITION);
  }
  return { always, onDemand };
}

/** 按需目录写进 system 的那一段；目录太大时只指路 tool_search。 */
export function toolIndexBrief(exposure: ToolExposure): string {
  if (!exposure.onDemand.length) return "";
  if (exposure.onDemand.length > INLINE_INDEX_LIMIT) {
    return `\n\n按需工具较多（${exposure.onDemand.length} 个）：先调用 tool_search 找工具，再用 tool_inspect 看参数，最后用 tool_call 执行。`;
  }
  return [
    "",
    "按需工具（先用 tool_inspect 看参数，再用 tool_call 执行）：",
    ...exposure.onDemand.map((entry) => `- ${entry.name}：${entry.summary}（${entry.group}）`)
  ].join("\n");
}
