import { externalToolSurface, mcpConfigFile, readMcpConfigs } from "../../adapter/outbound/integrations/clients.js";
import { listSkills, skillDirectories } from "../../adapter/outbound/integrations/skills.js";

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
