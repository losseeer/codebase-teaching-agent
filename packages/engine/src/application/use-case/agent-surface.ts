import type { AgentScope, AgentSurface, AgentToolEntry, PracticeOperation } from "@codebase-tutor/contract";
import { practiceOperationSchema } from "@codebase-tutor/contract";

import { PRACTICE_FACE_PLAN } from "../../exercises/turn-faces.js";
import { repositoryOr404 } from "../../infrastructure/composition-root.js";
import type { ImportedRepository } from "../../importer/importer.js";
import { INTERNAL_GROUPS, INTERNAL_REGISTRY } from "../../source/tools/registry.js";
import type { ToolContext, ToolDefinition, ToolGroup } from "../../source/tools/types.js";
import { staticIntegrationsUseCase } from "./integrations.js";

/** 只读能力面：技能清单与当前操作的工具面；不发模型请求。 */

function practiceOperation(raw: unknown): PracticeOperation {
  const parsed = practiceOperationSchema.safeParse(raw);
  return parsed.success ? parsed.data : "generate";
}

/** 只拿它判断工具可用性，不执行工具；能力字段与运行时 ExerciseFaces 同源。 */
function surfaceContext(repository: ImportedRepository, scope: AgentScope, operation: PracticeOperation, hasSkills: boolean): ToolContext {
  const ctx: ToolContext = {
    scope,
    repoPath: repository.path,
    ...(hasSkills ? { skills: { brief: "", bodyOf: () => undefined } } : {})
  };
  if (scope === "map") {
    ctx.search = {} as NonNullable<ToolContext["search"]>;
    ctx.facts = { apply: () => "" };
    ctx.diagram = { apply: () => "" };
    ctx.ask = { facets: ["range", "goal"] };
    return ctx;
  }
  if (scope === "teaching") {
    ctx.search = {} as NonNullable<ToolContext["search"]>;
    return ctx;
  }
  const plan = PRACTICE_FACE_PLAN[operation];
  if (plan.search) ctx.search = {} as NonNullable<ToolContext["search"]>;
  if (plan.facts) ctx.facts = { apply: () => "" };
  return ctx;
}

function unavailableReason(definition: ToolDefinition, ctx: ToolContext): string {
  const reason = definition.unavailable;
  return (typeof reason === "function" ? reason(ctx) : reason) ?? "当前操作不可用。";
}

function toolEntry(definition: ToolDefinition, group: ToolGroup, available: boolean, ctx: ToolContext): AgentToolEntry {
  return {
    name: definition.name,
    description: definition.summary,
    available,
    ...(available && group.id === "ask" ? { conditional: true, reason: "未选范围且连续提问未超限时才出现" } : {}),
    ...(available ? {} : { reason: unavailableReason(definition, ctx) })
  };
}

export function agentSurfaceUseCase(repositoryId: string, rawScope: unknown, rawOperation?: unknown): AgentSurface | undefined {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return undefined;
  const scope: AgentScope = rawScope === "teaching" || rawScope === "practice" ? rawScope : "map";
  const operation = scope === "practice" ? practiceOperation(rawOperation) : undefined;
  const integrations = staticIntegrationsUseCase();
  const ctx = surfaceContext(repository, scope, operation ?? "generate", integrations.skills.length > 0);
  const available = new Set(INTERNAL_REGISTRY.entries(ctx).map((entry) => entry.definition.name));
  const tools: AgentToolEntry[] = INTERNAL_GROUPS.flatMap((group) =>
    group.tools.map((definition) => toolEntry(definition, group, available.has(definition.name), ctx))
  );
  const externalAvailable = integrations.mcpConfigured && scope !== "practice";
  tools.push({
    name: "外部工具",
    description: "调用已配置的外部工具；具体工具取决于所连接的服务。",
    available: externalAvailable,
    ...(externalAvailable ? { conditional: true, reason: "连接成功后才出现" } : { reason: scope === "practice" ? "练习工作区不开放外部工具" : "没有配置外部工具" }),
    external: true
  });
  return { scope, ...(operation ? { operation } : {}), directories: integrations.skillDirectories, skills: integrations.skills, skillSkipped: integrations.skillSkipped, tools };
}
