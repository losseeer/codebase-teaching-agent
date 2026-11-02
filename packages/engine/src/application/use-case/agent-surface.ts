import type { AgentScope, AgentSurface, AgentToolEntry } from "@codebase-tutor/contract";

import { SET_DIAGRAM_TOOL } from "../../diagram/set-diagram.js";
import { QUERY_FACTS_TOOL } from "../../facts/query.js";
import { repositoryOr404 } from "../../infrastructure/composition-root.js";
import { CROSS_REPO_LINK_TOOL } from "../../seams/seams.js";
import { ASK_USER_TOOL_NAME } from "../../source/ask-user.js";
import { READ_FILE_TOOL } from "../../source/read-file.js";
import { SEARCH_CODE_TOOL } from "../../source/search-code.js";
import { crossRepoFor } from "../orchestration/paid-turn.js";
import { staticIntegrationsUseCase } from "./integrations.js";

/** 只读能力面：技能清单与当前作用区的工具面；不发模型请求。 */
export function agentSurfaceUseCase(repositoryId: string, rawScope: unknown): AgentSurface | undefined {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return undefined;
  const scope: AgentScope = rawScope === "teaching" || rawScope === "practice" ? rawScope : "map";
  const integrations = staticIntegrationsUseCase();
  const externalConfigured = integrations.mcpConfigured;
  const cross = scope === "practice" ? undefined : crossRepoFor(repository, new Map());
  const map = scope === "map";
  const tools: AgentToolEntry[] = [
    { name: READ_FILE_TOOL.name, description: READ_FILE_TOOL.description, available: true },
    { name: SEARCH_CODE_TOOL.name, description: SEARCH_CODE_TOOL.description, available: scope !== "practice", ...(scope === "practice" ? { reason: "练习答疑不开放检索" } : {}) },
    { name: CROSS_REPO_LINK_TOOL.name, description: CROSS_REPO_LINK_TOOL.description, available: Boolean(cross), ...(cross ? {} : { reason: scope === "practice" ? "练习答疑不开放跨仓工具" : "地址簿里没有其他仓" }) },
    { name: ASK_USER_TOOL_NAME, description: "需要范围或目标时先问你一句；一个回合最多一次。", available: map, ...(map ? { conditional: true, reason: "未选范围且连续提问未超限时才出现" } : { reason: "只在地图作用区开放" }) },
    { name: SET_DIAGRAM_TOOL.name, description: SET_DIAGRAM_TOOL.description, available: map, ...(map ? {} : { reason: "只在地图作用区开放" }) },
    { name: integrations.readSkillTool.name, description: integrations.readSkillTool.description, available: integrations.skills.length > 0, ...(integrations.skills.length ? {} : { reason: "没有装载技能" }) },
    { name: QUERY_FACTS_TOOL.name, description: QUERY_FACTS_TOOL.description, available: map, ...(map ? {} : { reason: "只在地图作用区开放" }) },
    {
      name: "外部工具",
      description: "调用配置好的外部工具；具体工具名随服务而定。",
      available: externalConfigured && scope !== "practice",
      ...(externalConfigured && scope !== "practice" ? { conditional: true, reason: "连接成功后才出现" } : {}),
      ...(scope === "practice" ? { reason: "练习答疑不开放外部工具" } : externalConfigured ? {} : { reason: "没有配置外部工具" }),
      external: true
    }
  ];
  return { scope, directories: integrations.skillDirectories, skills: integrations.skills, skillSkipped: integrations.skillSkipped, tools };
}
