import { createLightLlmProvider, createTeachingProvider, ThinkingOverrideLlmProvider, type LlmProvider, type ThinkingEffort } from "./provider.js";

/**
  LLM 运行时设置（GUI 可改，进程内存态）：
  - teachingModel / lightModel：模型 slug 覆盖，空串 = 用 .env 配置
  - thinking：teaching 档思考档位；"auto" = 不发思考字段（模型默认，DeepSeek V4 默认开启思考）
  - light 档固定 "off"：三个单轮轻任务（推荐入口/题面润色/地图命名）不需要思考，
    且 V4 默认开启思考导致这些任务白白烧 reasoning token（2026-09-15 实测教训）
  - 设置只存内存：重启回落 .env 行为（.env 是部署基线，GUI 是会话内调整）
  */
export interface LlmRuntimeSettings {
  teachingModel: string;
  lightModel: string;
  thinking: "auto" | ThinkingEffort;
}

const DEFAULT_SETTINGS: LlmRuntimeSettings = { teachingModel: "", lightModel: "", thinking: "auto" };

let settings: LlmRuntimeSettings = { ...DEFAULT_SETTINGS };

export function getLlmRuntimeSettings(): LlmRuntimeSettings {
  return { ...settings };
}

/** 部分更新（未提供且为 undefined 的字段保持不变）；模型字段 trim。非法 thinking 由路由层校验后才会到这里。 */
export function setLlmRuntimeSettings(partial: { teachingModel?: string; lightModel?: string; thinking?: LlmRuntimeSettings["thinking"] }): LlmRuntimeSettings {
  if (partial.teachingModel !== undefined) settings.teachingModel = partial.teachingModel.trim();
  if (partial.lightModel !== undefined) settings.lightModel = partial.lightModel.trim();
  if (partial.thinking !== undefined) settings.thinking = partial.thinking;
  return getLlmRuntimeSettings();
}

/** teaching 档：模型可被运行时覆盖，思考档位经包装器注入每次调用。 */
export function buildTeachingRuntimeProvider(): LlmProvider | undefined {
  const raw = createTeachingProvider({ model: settings.teachingModel || undefined });
  return raw ? new ThinkingOverrideLlmProvider(raw, settings.thinking) : undefined;
}

/** light 档：light 未配置时回落 teaching 模型（裸实例，避免双层思考包装），但思考强制 off。 */
export function buildLightRuntimeProvider(): LlmProvider | undefined {
  const raw = createLightLlmProvider({ model: settings.lightModel || undefined })
    ?? createTeachingProvider({ model: settings.teachingModel || undefined });
  return raw ? new ThinkingOverrideLlmProvider(raw, "off") : undefined;
}
