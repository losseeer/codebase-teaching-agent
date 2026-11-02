import type { AgentScope } from "@codebase-tutor/contract";

import { READ_FILE_DEFINITION } from "../read-file.js";
import { SEARCH_CODE_DEFINITION } from "../search-code.js";
import { ASK_USER_DEFINITION } from "../ask-user.js";
import { READ_SKILL_DEFINITION } from "../skills-tool.js";
import { SET_DIAGRAM_DEFINITION } from "../../diagram/set-diagram.js";
import { QUERY_FACTS_DEFINITION } from "../../facts/query.js";
import type { ToolContext, ToolDefinition, ToolGroup } from "./types.js";

/** 进程级注册表：内部工具按领域分组；MCP 由适配器按本轮上下文补充分组。 */

export const INTERNAL_GROUPS: ToolGroup[] = [
  {
    id: "repo",
    summary: "仓库取证：读文件与检索",
    scope: "all",
    available: (ctx) => Boolean(ctx.repoPath),
    tools: [READ_FILE_DEFINITION, SEARCH_CODE_DEFINITION]
  },
  {
    id: "ask",
    summary: "向用户提问",
    scope: ["map"],
    available: (ctx) => Boolean(ctx.ask?.facets.length),
    tools: [ASK_USER_DEFINITION]
  },
  {
    id: "diagram",
    summary: "画布结构",
    scope: ["map"],
    available: (ctx) => Boolean(ctx.diagram),
    tools: [SET_DIAGRAM_DEFINITION]
  },
  {
    id: "skills",
    summary: "技能正文",
    scope: "all",
    available: (ctx) => Boolean(ctx.skills),
    tools: [READ_SKILL_DEFINITION]
  },
  {
    id: "facts",
    summary: "静态产物",
    scope: "all",
    available: (ctx) => Boolean(ctx.facts),
    tools: [QUERY_FACTS_DEFINITION]
  }
];

export function scopeAllows(scope: AgentScope[] | "all" | undefined, current: AgentScope): boolean {
  return !scope || scope === "all" || scope.includes(current);
}

export interface ToolEntry {
  definition: ToolDefinition;
  group: ToolGroup;
}

export class ToolRegistry {
  constructor(private readonly groups: ToolGroup[]) {}

  entries(ctx: ToolContext): ToolEntry[] {
    const entries: ToolEntry[] = [];
    for (const group of this.groups) {
      if (!scopeAllows(group.scope, ctx.scope) || !group.available(ctx)) continue;
      for (const definition of group.tools) {
        if (!scopeAllows(definition.scope, ctx.scope)) continue;
        if (definition.available && !definition.available(ctx)) continue;
        entries.push({ definition, group });
      }
    }
    return entries;
  }

  find(name: string, ctx: ToolContext): ToolDefinition | undefined {
    return this.entries(ctx).find((entry) => entry.definition.name === name)?.definition;
  }

  known(name: string): ToolDefinition | undefined {
    for (const group of this.groups) {
      const hit = group.tools.find((definition) => definition.name === name);
      if (hit) return hit;
    }
    return undefined;
  }
}

export const INTERNAL_REGISTRY = new ToolRegistry(INTERNAL_GROUPS);

/** 界面能力面：内部工具按注册表顺序展开，不连接 MCP。 */
export function internalDefinitions(): ToolDefinition[] {
  return INTERNAL_GROUPS.flatMap((group) => group.tools);
}

/** 本轮注册表：内部分组 + MCP 适配器给出的分组。 */
export function registryFor(ctx: ToolContext): ToolRegistry {
  return new ToolRegistry([...INTERNAL_GROUPS, ...(ctx.external?.groups ?? [])]);
}
