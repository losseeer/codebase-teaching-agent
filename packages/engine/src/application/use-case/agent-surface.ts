import type { AgentScope, AgentSurface, AgentToolEntry } from "@codebase-tutor/contract";

import { repositoryOr404 } from "../../infrastructure/composition-root.js";
import { internalDefinitions } from "../../source/tools/registry.js";
import { staticIntegrationsUseCase } from "./integrations.js";

/** 只读能力面：技能清单与当前工作区的工具面；不发模型请求。 */
export function agentSurfaceUseCase(repositoryId: string, rawScope: unknown): AgentSurface | undefined {
  if (!repositoryOr404(repositoryId)) return undefined;
  const scope: AgentScope = rawScope === "teaching" || rawScope === "practice" ? rawScope : "map";
  const integrations = staticIntegrationsUseCase();
  const externalConfigured = integrations.mcpConfigured;
  const map = scope === "map";
  const summaryOf = (name: string): string => internalDefinitions().find((definition) => definition.name === name)?.summary ?? name;
  const tools: AgentToolEntry[] = [
    { name: "read_file", description: summaryOf("read_file"), available: true },
    { name: "search_code", description: summaryOf("search_code"), available: scope !== "practice", ...(scope === "practice" ? { reason: "练习工作区不开放检索" } : {}) },
    { name: "ask_user", description: summaryOf("ask_user"), available: map, ...(map ? { conditional: true, reason: "未选范围且连续提问未超限时才出现" } : { reason: "只在架构全景工作区开放" }) },
    { name: "set_diagram", description: summaryOf("set_diagram"), available: map, ...(map ? {} : { reason: "只在架构全景工作区开放" }) },
    { name: "read_skill", description: summaryOf("read_skill"), available: integrations.skills.length > 0, ...(integrations.skills.length ? {} : { reason: "没有装载技能" }) },
    { name: "query_facts", description: summaryOf("query_facts"), available: map, ...(map ? {} : { reason: "只在架构全景工作区开放" }) },
    {
      name: "外部工具",
      description: "调用已配置的外部工具；具体工具取决于所连接的服务。",
      available: externalConfigured && scope !== "practice",
      ...(externalConfigured && scope !== "practice" ? { conditional: true, reason: "连接成功后才出现" } : {}),
      ...(scope === "practice" ? { reason: "练习工作区不开放外部工具" } : externalConfigured ? {} : { reason: "没有配置外部工具" }),
      external: true
    }
  ];
  return { scope, directories: integrations.skillDirectories, skills: integrations.skills, skillSkipped: integrations.skillSkipped, tools };
}
