import { externalToolSurface, mcpConfigFile, readMcpConfigs } from "../../adapter/outbound/integrations/clients.js";
import { listSkills, restoreBundledSkills, skillDirectories } from "../../adapter/outbound/integrations/skills.js";

/** 只读能力面的静态读数：技能清单与 MCP 是否配置；不连 server、不发模型。 */
export function staticIntegrationsUseCase() {
  const skills = listSkills();
  return {
    skills: skills.skills,
    skillSkipped: skills.skipped,
    skillDirectories: skillDirectories(),
    mcpConfigured: readMcpConfigs().servers.length > 0
  };
}

/** 外部能力面的读数口（零 token）：技能清单、MCP 配置、本轮工具清单与连接失败原因；读时会把没连上的 server 拉起一次。 */
export async function externalSurfaceUseCase() {
  const skills = listSkills();
  const surface = await externalToolSurface();
  return {
    skillDirectories: skillDirectories(),
    skills: skills.skills,
    skillSkipped: skills.skipped,
    mcpConfigFile: mcpConfigFile(),
    mcpConfigSkipped: readMcpConfigs().skipped,
    tools: (surface?.tools ?? []).map((tool) => tool.name),
    errors: surface?.errors ?? []
  };
}

/** 恢复出厂技能：把用户技能目录里「出厂技能」的副本逐文件覆盖回出厂版本（含用户配置）。用户自建的技能不动。 */
export function restoreSkillsUseCase(): { restored: string[]; files: number } {
  return restoreBundledSkills({ includeUserOwned: true });
}
