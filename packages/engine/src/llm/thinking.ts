/**
  思考参数能力声明（按模型家族查表，2026-09-15 官方文档核实）：
  - deepseek（官方 Chat Completions）：顶层 thinking {type:"enabled"/"disabled"}（默认 enabled、effort 默认 high）
    + reasoning_effort: low/high/max（medium 会被映射为 high、xhigh 映射为 max）
  - openai（顶层 reasoning_effort，Chat Completions）：
    * GPT-5.6+：none/low/medium/high/xhigh/max（minimal 已移除）
    * GPT-5.2~5.5：none/low/medium/high/xhigh（官方帮助中心口径，5.2 起支持 none）
    * GPT-5 初代（gpt-5/-mini/-nano）：minimal/low/medium/high（不支持关闭）
    * o 系列（o1/o3/o4）：low/medium/high（不支持关闭）
    * 发送模型不支持的取值 OpenAI 直接报 unsupported_value 错误
  - anthropic（OpenAI 兼容层 /v1/chat/completions）：仅支持 thinking {type:"enabled", budget_tokens} 开关，
    新版 Claude 为自适应思考（Claude 5 默认开启）；兼容层不支持 effort 档位参数
  - gemini（OpenAI 兼容层）：顶层 reasoning_effort: minimal/low/medium/high（映射到 thinking_level/budget）；
    2.5 非 Pro 可用 "none" 关闭，2.5 Pro 与 Gemini 3 无法关闭思考
  - glm（智谱 OpenAI 兼容 API）：thinking {type:"enabled"/"disabled"} 开关（GLM-4.5+，默认开启）；
    reasoning_effort 仅 GLM-5.2+ 支持（none/minimal/low/medium/high/xhigh/max，low/medium 映射为 high），
    GLM-5.3 只剩 low/high/max 且无法关闭思考；GLM-4.5~5.1 只有开关没有强度档
  - kimi（月之暗面 OpenAI 兼容 API）：仅 thinking {type:"enabled"/"disabled"} 开关，无 effort 档位；
    kimi-k2.5 / kimi-k2.6 可关闭（默认开启）；kimi-k2.7-code 与 kimi-k3 为强制思考，传 disabled 会报错
  - unknown：表内没有的模型。auto/off 都不发字段；显式档位显式报错，
    可用 TUTOR_THINKING_STYLES=前缀=样式,前缀=样式 为私有/新模型声明能力（样式：deepseek|openai|anthropic|none）
  */
import type { ThinkingEffort } from "./provider.js";

export type ThinkingStyle = "deepseek" | "openai" | "anthropic" | "none" | "unknown";

export interface ThinkingCapability {
  style: ThinkingStyle;
  /** 档位 → 该家族 API 的实际取值。未列出的档位 = 该模型不支持，显式下发时直接报错。 */
  efforts: Partial<Record<ThinkingEffort, string>>;
}

/** 各样式在 TUTOR_THINKING_STYLES 里声明时采用的标准档位映射。 */
const STYLE_VOCABULARIES: Record<Exclude<ThinkingStyle, "unknown">, ThinkingCapability["efforts"]> = {
  deepseek: { off: "disabled", low: "low", high: "high", max: "max" },
  openai: { off: "none", low: "low", high: "high", max: "xhigh" },
  anthropic: { off: "disabled" },
  none: {}
};

/** 内置能力表：前缀匹配，先命中先赢（更具体的前缀必须排在前面）。 */
const BUILTIN_CAPABILITIES: { prefix: string; capability: ThinkingCapability }[] = [
  // deepseek-flash：官方现役模型名（2026-09-15 官方文档；旧名 deepseek-v4-flash 为遗留别名，
  // 请求同样由 DeepSeek-V4.1-Flash 提供服务），思考参数与 V4 格式一致，默认开启思考
  { prefix: "deepseek-flash", capability: { style: "deepseek", efforts: { off: "disabled", low: "low", high: "high", max: "max" } } },
  // DeepSeek V4：thinking 开关 + effort 三档，默认开启思考（2026-09 官方文档）
  { prefix: "deepseek-v4", capability: { style: "deepseek", efforts: { off: "disabled", low: "low", high: "high", max: "max" } } },
  // 旧 DeepSeek 模型无思考参数（deepseek-v3 系将于 2026-10-10 下架）
  { prefix: "deepseek-chat", capability: { style: "none", efforts: {} } },
  { prefix: "deepseek-reasoner", capability: { style: "none", efforts: {} } },
  { prefix: "deepseek-v3", capability: { style: "none", efforts: {} } },
  // OpenAI GPT-5.6+：none/max 是真实 API 取值
  { prefix: "gpt-5.6", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high", max: "max" } } },
  // GPT-5.2~5.5：5.2 起支持 none，最高 xhigh（max 取值 5.6 才有）
  { prefix: "gpt-5.5", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high", max: "xhigh" } } },
  { prefix: "gpt-5.4", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high", max: "xhigh" } } },
  { prefix: "gpt-5.3", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high", max: "xhigh" } } },
  { prefix: "gpt-5.2", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high", max: "xhigh" } } },
  // GPT-5 初代 / o 系列：只有 low/medium/high，不支持关闭
  { prefix: "gpt-5", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "o1", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "o3", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "o4", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  // Anthropic OpenAI 兼容层：只有 thinking 开关，无 effort 档位
  { prefix: "claude", capability: { style: "anthropic", efforts: { off: "disabled" } } },
  // Gemini：3 系与 2.5 Pro 不能关闭思考；max 取值不存在
  { prefix: "gemini-3", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "gemini-2.5-pro", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "gemini-2.5", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high" } } },
  // GLM（智谱）：与 DeepSeek 同构（thinking 开关 + reasoning_effort）。注意前缀顺序——glm-5.3/glm-5.2 必须在 glm-5 之前
  // GLM-5.3：只剩 low/high/max，无法关闭思考（2026-09 官方文档）
  { prefix: "glm-5.3", capability: { style: "deepseek", efforts: { low: "low", high: "high", max: "max" } } },
  // GLM-5.2+：thinking 开关 + effort 全档（low/medium 会被映射为 high，对调用方透明）
  { prefix: "glm-5.2", capability: { style: "deepseek", efforts: { off: "disabled", low: "low", high: "high", max: "max" } } },
  // GLM-5.0/5.1、4.6、4.5：只有 thinking 开关，无强度档
  { prefix: "glm-5", capability: { style: "anthropic", efforts: { off: "disabled" } } },
  { prefix: "glm-4.6", capability: { style: "anthropic", efforts: { off: "disabled" } } },
  { prefix: "glm-4.5", capability: { style: "anthropic", efforts: { off: "disabled" } } },
  // Kimi（月之暗面）：只有 thinking 开关，无 effort 档位
  // kimi-k2.7-code 与 kimi-k3 强制思考，无法关闭（发 disabled 直接报错）
  { prefix: "kimi-k2.7-code", capability: { style: "anthropic", efforts: {} } },
  { prefix: "kimi-k3", capability: { style: "anthropic", efforts: {} } },
  // kimi-k2.5 / kimi-k2.6 可关闭（默认开启）
  { prefix: "kimi-k2.5", capability: { style: "anthropic", efforts: { off: "disabled" } } },
  { prefix: "kimi-k2.6", capability: { style: "anthropic", efforts: { off: "disabled" } } }
];

/** TUTOR_THINKING_STYLES 解析缓存（启动后不变，解析一次即可）。 */
let envOverrides: { prefix: string; capability: ThinkingCapability }[] | undefined;

/** 仅供测试：TUTOR_THINKING_STYLES 在进程内只解析一次，测试改环境变量后需要重置缓存。 */
export function resetThinkingEnvCacheForTests(): void {
  envOverrides = undefined;
}

function parseEnvOverrides(): { prefix: string; capability: ThinkingCapability }[] {
  if (envOverrides) return envOverrides;
  const raw = process.env.TUTOR_THINKING_STYLES ?? "";
  const entries: { prefix: string; capability: ThinkingCapability }[] = [];
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      console.warn(`[thinking] TUTOR_THINKING_STYLES 条目格式非法（应为 前缀=样式）：${trimmed}`);
      continue;
    }
    const prefix = trimmed.slice(0, eq).trim();
    const style = trimmed.slice(eq + 1).trim().toLowerCase();
    if (!(style in STYLE_VOCABULARIES)) {
      console.warn(`[thinking] TUTOR_THINKING_STYLES 样式非法（支持 deepseek/openai/anthropic/none）：${trimmed}`);
      continue;
    }
    entries.push({ prefix, capability: { style: style as ThinkingStyle, efforts: { ...STYLE_VOCABULARIES[style as Exclude<ThinkingStyle, "unknown">] } } });
  }
  envOverrides = entries;
  return entries;
}

/** 按模型 slug 解析思考能力。OpenRouter 风格的 vendor 前缀 slug（如 deepseek/deepseek-v4-flash）
    会对完整 slug 与最后一段分别做前缀匹配。 */
export function resolveThinkingCapability(model: string): ThinkingCapability {
  const slug = model.trim();
  const candidates = slug.includes("/") ? [slug, slug.slice(slug.lastIndexOf("/") + 1)] : [slug];
  for (const entry of parseEnvOverrides()) {
    if (candidates.some((candidate) => candidate.startsWith(entry.prefix))) return entry.capability;
  }
  for (const entry of BUILTIN_CAPABILITIES) {
    if (candidates.some((candidate) => candidate.startsWith(entry.prefix))) return entry.capability;
  }
  return { style: "unknown", efforts: {} };
}

/** 该模型支持的显式档位（auto 恒可用，不在此列）。 */
export function supportedThinkingEfforts(capability: ThinkingCapability): ThinkingEffort[] {
  return (["off", "low", "high", "max"] as const).filter((effort) => effort in capability.efforts);
}

/**
  某模型是否接受某个思考档位（保存设置时的前置校验用，与 applyThinking 的接受逻辑一致）：
  - auto 恒可用；档位在能力表 efforts 里 → 可用
  - off 额外恒可用于 none/unknown 样式（= 不发字段，applyThinking 同款豁免）
  */
export function isThinkingEffortSupported(model: string, effort: "auto" | ThinkingEffort): boolean {
  if (effort === "auto") return true;
  const capability = resolveThinkingCapability(model);
  if (effort in capability.efforts) return true;
  return effort === "off" && (capability.style === "none" || capability.style === "unknown");
}

/**
  把思考档位写入 OpenAI Chat Completions 请求体（就地修改 payload）。
  - deepseek/anthropic 样式：off → thinking:{type:"disabled"}；low/high/max → thinking:{type:"enabled"}（deepseek 另加 reasoning_effort）
  - openai 样式：一律走顶层 reasoning_effort（off 映射到 "none"）
  - none/unknown：off = 不发任何字段；显式思考档位抛错（不许静默降级——假装没看见就是伪装失败）
  */
export function applyThinking(payload: Record<string, unknown>, model: string, effort: ThinkingEffort): void {
  const capability = resolveThinkingCapability(model);
  const mapped = capability.efforts[effort];
  if (mapped === undefined) {
    // off 对任何模型都可表达：无思考参数/未知模型 = 不发字段（关不掉思考的模型才会真正不支持）
    if (effort === "off" && (capability.style === "none" || capability.style === "unknown")) return;
    const supported = supportedThinkingEfforts(capability);
    const declare = capability.style === "unknown" ? "。可用 TUTOR_THINKING_STYLES=模型前缀=deepseek|openai|anthropic|none 为该模型声明能力" : "";
    throw new Error(
      `模型 ${model} 不支持思考档位 "${effort}"（能力样式 ${capability.style}，支持：${supported.length ? supported.join("/") : "无"}）${declare}`
    );
  }
  if (capability.style === "openai") {
    payload.reasoning_effort = mapped;
    return;
  }
  if (effort === "off") {
    payload.thinking = { type: "disabled" };
    return;
  }
  payload.thinking = { type: "enabled" };
  if (capability.style === "deepseek") payload.reasoning_effort = mapped;
}
