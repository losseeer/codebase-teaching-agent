import type { AgentScope, ScopedStreamProgress } from "@codebase-tutor/contract";
import type { McpCallAudit } from "@codebase-tutor/domain";

import type { LlmTool } from "../../application/port/llm-provider.js";
import type { AskFacet, AskResume, AskUserAudit } from "../ask-user.js";
import type { FileReadRecord } from "../read-file.js";
import type { CodeSearchRecord, SearchCorpus } from "../search-code.js";

/** 工具注册与加载：定义、分组、暴露、调用共用这一份形状。 */

export type ReadToolProgress = Exclude<ScopedStreamProgress, { type: "delta" } | { type: "progress" }>;

/** 一次模型或工具调用的轨迹帧；归属由装配层补。 */
export interface ToolTraceStep {
  kind: "model" | "tool";
  status: "start" | "ok" | "error";
  stepId: string;
  label: string;
  detail?: string;
  /** 模型这一轮的回复正文；工具帧不填。 */
  reply?: string;
  round: number;
  tool?: string;
  model?: string;
  ms?: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
}

/** 技能正文通道。 */
export interface SkillsToolContext {
  /** 进上下文的技能清单文本。 */
  brief: string;
  /** 取技能正文或该目录下的附属文件；`file` 省略时取 SKILL.md，返回 `undefined` 表示不存在。 */
  bodyOf: (name: string, file?: string) => string | undefined;
}

/** 外部 MCP 工具的清单与调用通道。 */
export interface ExternalToolContext {
  /** 一台 server 一个分组；名字带 `mcp__<server>__` 前缀。 */
  groups: ToolGroup[];
  /** 不许抛异常：外部 server 的超时与失败须先转成给模型看的文本。 */
  call: (name: string, argumentsJson: string) => Promise<{ text: string; audit: McpCallAudit }>;
  /** 一个回合的外部调用次数上限；省略取缺省。 */
  maxCalls?: number;
}

/** set_diagram 的执行通道，返回落盘结果或拒写原因。 */
export interface SetDiagramToolContext {
  apply: (argumentsJson: string) => string;
  /** 画布现场快照。 */
  inventory?: string;
}

/** 静态产物的查询通道。 */
export interface FactsToolContext {
  /** 静态产物在册情况，随上下文常驻。 */
  inventory?: string;
  apply: (argumentsJson: string) => string;
}

/** 本轮工具上下文：只含本轮输入，不持有会话状态。 */
export interface ToolContext {
  scope: AgentScope;
  repoPath?: string;
  search?: SearchCorpus;
  diagram?: SetDiagramToolContext;
  facts?: FactsToolContext;
  skills?: SkillsToolContext;
  ask?: { facets: AskFacet[]; resume?: AskResume };
  external?: ExternalToolContext;
  signal?: AbortSignal;
  onProgress?: (progress: ReadToolProgress) => void;
  /** 本轮按需目录；由装配层算好，目录工具与调用器共用。 */
  catalog?: ToolCatalog;
}

/** 按需目录：只包含本轮被收起的工具。 */
export interface ToolCatalog {
  entries: ToolIndexEntry[];
  find: (name: string) => ToolDefinition | undefined;
}

export interface ToolIndexEntry {
  name: string;
  summary: string;
  tags?: string[];
  group: string;
}

export interface ToolInfo {
  name: string;
  summary: string;
  schema: Record<string, unknown>;
  examples?: unknown[];
  outputSchema?: Record<string, unknown>;
  version?: string;
  effect: ToolEffect;
  origin: ToolOrigin;
}

export type ToolEffect = "read" | "write" | "external";
export type ToolOrigin = { kind: "internal" } | { kind: "mcp"; server: string };
export type ToolExposureMode = "always" | "auto" | "on-demand";

export interface ToolDefinition {
  name: string;
  /** 选择用，一行。参数、约束与示例进 inspect。 */
  summary: string;
  tags?: string[];
  /** 静态 JSON Schema；不随回合变化。 */
  schema: Record<string, unknown>;
  examples?: unknown[];
  outputSchema?: Record<string, unknown>;
  exposure: ToolExposureMode;
  effect: ToolEffect;
  origin: ToolOrigin;
  version?: string;
  /** 工作区；缺省 all。界面能力面据此过滤。 */
  scope?: AgentScope[] | "all";
  /** 需要的能力面；界面能力面据此标注不可用。 */
  requires?: "skills" | "external";
  /** 只在架构全景工作区且条件满足时出现。 */
  conditional?: boolean;
  /** 读文件 / 外部调用的每回合额度类别。 */
  cost?: "read" | "external";
  available?: (ctx: ToolContext) => boolean;
  /** 当前上下文不可用时的说明；不给就按未知工具回。 */
  unavailable?: string | ((ctx: ToolContext) => string);
  invoke: (args: unknown, ctx: ToolContext) => Promise<ToolOutcome> | ToolOutcome;
  describe?: (args: unknown) => { label: string; detail?: string };
  inspect?: () => ToolInfo;
}

export interface ToolGroup {
  id: string;
  summary: string;
  scope: AgentScope[] | "all";
  available: (ctx: ToolContext) => boolean;
  tools: ToolDefinition[];
}

export interface ToolExposure {
  always: ToolDefinition[];
  onDemand: ToolIndexEntry[];
}

/** 暴露层与调用器只依赖这三个方法；实现由 registry.ts 提供。 */
export interface ToolRegistryLike {
  entries(ctx: ToolContext): { definition: ToolDefinition; group: ToolGroup }[];
  find(name: string, ctx: ToolContext): ToolDefinition | undefined;
  /** 不看可用性，只回答注册表里有没有这个名字。 */
  known(name: string): ToolDefinition | undefined;
}

export interface ToolStop {
  reason: "await_user";
  asked: Omit<AskUserAudit, "toolCallId">;
}

export interface SkillReadRecord {
  skill: string;
  chars: number;
  found: boolean;
  /** 实际取技能的时刻；journal 晚写时据此还原轨迹顺序。 */
  occurredAt?: string;
}

/** `skill_read` 一行的形状。 */
export function skillReadAuditPayload(read: SkillReadRecord): Record<string, string | number | boolean> {
  return { skill: read.skill, chars: read.chars, found: read.found, ...(read.occurredAt ? { occurred_at: read.occurredAt } : {}) };
}

export interface ToolOutcome {
  text: string;
  /** 缺省 true；false 时轨迹记 error。 */
  ok?: boolean;
  detail?: string;
  /** 控制流工具用信号结束本轮，不靠工具名特判。 */
  stop?: ToolStop;
  askRefused?: string;
  audits?: {
    fileReads?: FileReadRecord[];
    codeSearches?: CodeSearchRecord[];
    skillReads?: SkillReadRecord[];
    mcpCalls?: McpCallAudit[];
  };
}

/** 把 LlmTool 转成模型请求里的形状。 */
export function toLlmTool(definition: ToolDefinition): LlmTool {
  return { name: definition.name, description: definition.summary, parameters: definition.schema };
}

/** 架构键：schema 变更要进检查点/缓存键与审计。 */
export function toolSchemaHash(definitions: readonly ToolDefinition[]): string {
  return definitions.map((definition) => `${definition.name}:${JSON.stringify(definition.schema)}`).sort().join("|");
}
