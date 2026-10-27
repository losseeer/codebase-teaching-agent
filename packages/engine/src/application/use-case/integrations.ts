import { externalToolSurface, mcpConfigFile, readMcpConfigs } from "../../adapter/outbound/integrations/clients.js";
import { listSkills, skillDirectories } from "../../adapter/outbound/integrations/skills.js";

/**
  外部能力面的读数口（零 token）：装了哪些技能、配置文件里有哪些 server、这轮真并进请求的工具清单，以及连不上的原因。
  读它会顺带把没连上的 server 拉起一次——「连不上」要来自真实尝试，不能是猜的。
  */
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
