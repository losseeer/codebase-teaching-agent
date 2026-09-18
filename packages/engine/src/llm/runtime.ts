import { LoggingLlmProvider } from "./call-log.js";
import { createLlmProvider, ThinkingOverrideLlmProvider, type LlmProvider, type ThinkingEffort } from "./provider.js";

/**
  LLM 运行时设置（GUI 可改，进程内存态；重启回落 .env）。
  **只有一套配置**（2026-09-18 起不再有 teaching / light 两个配置槽）：
  - model：模型 slug 覆盖，空串 = 用 .env 配置；
  - thinking：深任务（三作用域对话、流程生成）的思考档位，"auto" = 不发思考字段（模型默认，
    DeepSeek V4 默认开启思考）。
  「轻任务 / 教学对话」是**运行时角色**而非两份配置，见 buildLlmRuntimeProvider。
  */
export interface LlmRuntimeSettings {
  model: string;
  thinking: "auto" | ThinkingEffort;
}

const DEFAULT_SETTINGS: LlmRuntimeSettings = { model: "", thinking: "auto" };

let settings: LlmRuntimeSettings = { ...DEFAULT_SETTINGS };

export function getLlmRuntimeSettings(): LlmRuntimeSettings {
  return { ...settings };
}

/** 部分更新（未提供的字段保持不变）；模型字段 trim。非法 thinking 由路由层校验后才会到这里。 */
export function setLlmRuntimeSettings(partial: { model?: string; thinking?: LlmRuntimeSettings["thinking"] }): LlmRuntimeSettings {
  if (partial.model !== undefined) settings.model = partial.model.trim();
  if (partial.thinking !== undefined) settings.thinking = partial.thinking;
  return getLlmRuntimeSettings();
}

/** 同一套配置的两个运行时角色；llm.log 的 tier 仍按角色记账，方便区分深浅任务的成本。 */
export type LlmRole = "teaching" | "light";

/**
  - "teaching"：三作用域对话、流程生成等深任务——思考档位随运行时设置；
  - "light"：推荐入口 / 题面润色 / 命名 / L1 摘要等单轮浅任务——思考强制 "off"
    （这是行为约定，不是第二份配置；开了思考只会白烧 reasoning token，2026-09-15 实测教训）。
  */
export function buildLlmRuntimeProvider(role: LlmRole): LlmProvider | undefined {
  const raw = createLlmProvider({ model: settings.model || undefined });
  return raw ? new ThinkingOverrideLlmProvider(new LoggingLlmProvider(raw, role), role === "light" ? "off" : settings.thinking) : undefined;
}
