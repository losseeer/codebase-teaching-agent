/**
  思考参数能力表：按模型前缀查表，先命中先赢；表外模型 auto/off 不发字段、显式档位报错。
  私有或新模型用 `TUTOR_THINKING_STYLES=前缀=样式` 声明能力（样式：deepseek|openai|anthropic|none）。
  */
import type { ThinkingEffort } from "../../../application/port/llm-provider.js";

export type ThinkingStyle = "deepseek" | "openai" | "anthropic" | "none" | "unknown";

export interface ThinkingCapability {
  style: ThinkingStyle;
  /** 档位 → 该家族 API 的实际取值；未列出的档位表示不支持。 */
  efforts: Partial<Record<ThinkingEffort, string>>;
}

/** 各样式在 `TUTOR_THINKING_STYLES` 里的标准档位映射。 */
const STYLE_VOCABULARIES: Record<Exclude<ThinkingStyle, "unknown">, ThinkingCapability["efforts"]> = {
  deepseek: { off: "disabled", low: "low", high: "high", max: "max" },
  openai: { off: "none", low: "low", high: "high", max: "xhigh" },
  anthropic: { off: "disabled" },
  none: {}
};

/** 内置能力表：前缀匹配，先命中先赢（更具体的前缀必须排在前面）。 */
const BUILTIN_CAPABILITIES: { prefix: string; capability: ThinkingCapability }[] = [
  { prefix: "deepseek-flash", capability: { style: "deepseek", efforts: { off: "disabled", low: "low", high: "high", max: "max" } } },
  { prefix: "deepseek-v4", capability: { style: "deepseek", efforts: { off: "disabled", low: "low", high: "high", max: "max" } } },
  { prefix: "deepseek-chat", capability: { style: "none", efforts: {} } },
  { prefix: "deepseek-reasoner", capability: { style: "none", efforts: {} } },
  { prefix: "deepseek-v3", capability: { style: "none", efforts: {} } },
  { prefix: "gpt-5.6", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high", max: "max" } } },
  // GPT-5.2~5.5：最高档是 xhigh，max 取值要到 5.6
  { prefix: "gpt-5.5", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high", max: "xhigh" } } },
  { prefix: "gpt-5.4", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high", max: "xhigh" } } },
  { prefix: "gpt-5.3", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high", max: "xhigh" } } },
  { prefix: "gpt-5.2", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high", max: "xhigh" } } },
  // GPT-5 初代与 o 系列：只有 low/medium/high，思考关不掉
  { prefix: "gpt-5", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "o1", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "o3", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "o4", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "claude", capability: { style: "anthropic", efforts: { off: "disabled" } } },
  // Gemini 3 系与 2.5 Pro 不能关闭思考
  { prefix: "gemini-3", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "gemini-2.5-pro", capability: { style: "openai", efforts: { low: "low", high: "high" } } },
  { prefix: "gemini-2.5", capability: { style: "openai", efforts: { off: "none", low: "low", high: "high" } } },
  // 前缀顺序：glm-5.3 与 glm-5.2 必须排在 glm-5 之前
  { prefix: "glm-5.3", capability: { style: "deepseek", efforts: { low: "low", high: "high", max: "max" } } },
  { prefix: "glm-5.2", capability: { style: "deepseek", efforts: { off: "disabled", low: "low", high: "high", max: "max" } } },
  { prefix: "glm-5", capability: { style: "anthropic", efforts: { off: "disabled" } } },
  { prefix: "glm-4.6", capability: { style: "anthropic", efforts: { off: "disabled" } } },
  { prefix: "glm-4.5", capability: { style: "anthropic", efforts: { off: "disabled" } } },
  // kimi-k2.7-code 与 kimi-k3 强制思考，关不掉
  { prefix: "kimi-k2.7-code", capability: { style: "anthropic", efforts: {} } },
  { prefix: "kimi-k3", capability: { style: "anthropic", efforts: {} } },
  { prefix: "kimi-k2.5", capability: { style: "anthropic", efforts: { off: "disabled" } } },
  { prefix: "kimi-k2.6", capability: { style: "anthropic", efforts: { off: "disabled" } } }
];

/** `TUTOR_THINKING_STYLES` 的解析缓存。 */
let envOverrides: { prefix: string; capability: ThinkingCapability }[] | undefined;

/** 重置思考能力的环境变量解析缓存，供测试改环境变量后重读。 */
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

/** 按模型 slug 解析思考能力；vendor 前缀 slug 对完整 slug 与最后一段分别匹配。 */
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

/** 该模型是否接受某个思考档位；`off` 对 none/unknown 样式恒可用。 */
export function isThinkingEffortSupported(model: string, effort: "auto" | ThinkingEffort): boolean {
  if (effort === "auto") return true;
  const capability = resolveThinkingCapability(model);
  if (effort in capability.efforts) return true;
  return effort === "off" && (capability.style === "none" || capability.style === "unknown");
}

/** 把思考档位写入 OpenAI Chat Completions 请求体，就地修改 payload。 */
export function applyThinking(payload: Record<string, unknown>, model: string, effort: ThinkingEffort): void {
  const capability = resolveThinkingCapability(model);
  const mapped = capability.efforts[effort];
  if (mapped === undefined) {
    // none/unknown 样式的 off 即不发任何思考字段
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
