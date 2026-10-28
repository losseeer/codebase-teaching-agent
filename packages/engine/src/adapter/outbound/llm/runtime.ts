import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LoggingLlmProvider } from "./call-log.js";
import { createLlmProvider, resolveLlmConfig, ThinkingOverrideLlmProvider, TIMEOUT_MAX_MS, TIMEOUT_MIN_MS, type LlmConfigOverrides, type ResolvedLlmConfig } from "./provider.js";
import type { LlmProvider, ThinkingEffort } from "../../../application/port/llm-provider.js";
import { tutorDataDir } from "@codebase-tutor/platform";

/** GUI 可改的 LLM 运行时设置，落盘 `~/.codebase-tutor/llm-settings.json`；空串 = 该项回落 `.env`。 */
export interface LlmRuntimeSettings {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  thinking: "auto" | ThinkingEffort;
  /** 单价，单位 USD/百万 token；空串 = 回落 `.env`。 */
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  cacheHitUsdPerMillion: string;
  /** 单次请求超时（毫秒）；空串 = 回落 `TUTOR_LLM_TIMEOUT_MS`。 */
  timeoutMs: string;
}

/** GUI 可选的服务商协议；空串 = 回落 `.env`。 */
export const LLM_PROVIDERS = ["openai-compatible", "openai"] as const;

/** 可选思考档位；`"auto"` = 不发字段。 */
export const THINKING_EFFORTS = ["auto", "off", "low", "high", "max"] as const;

/** 单价项的键名清单。 */
export const PRICING_KEYS = ["inputUsdPerMillion", "outputUsdPerMillion", "cacheHitUsdPerMillion"] as const;

const TEXT_KEYS = ["provider", "model", "baseUrl", "apiKey"] as const;

const DEFAULT_SETTINGS: LlmRuntimeSettings = {
  provider: "", model: "", baseUrl: "", apiKey: "", thinking: "auto",
  inputUsdPerMillion: "", outputUsdPerMillion: "", cacheHitUsdPerMillion: "", timeoutMs: ""
};

/** 单价输入校验：空串或有限非负数才收，其余返回 `undefined`。 */
export function normalizeRate(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? String(value) : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? trimmed : undefined;
}

/** 超时输入校验：空串或 `[TIMEOUT_MIN_MS, TIMEOUT_MAX_MS]` 内的整数毫秒才收。 */
export function normalizeTimeoutMs(value: unknown): string | undefined {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : undefined;
  if (raw === undefined) return undefined;
  if (!raw) return "";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < TIMEOUT_MIN_MS || parsed > TIMEOUT_MAX_MS) return undefined;
  return raw;
}

/** 设置文件路径；测试用 `TUTOR_LLM_SETTINGS_FILE` 指向临时文件。 */
function settingsFile(): string {
  return process.env.TUTOR_LLM_SETTINGS_FILE ?? join(tutorDataDir(), "llm-settings.json");
}

let settings: LlmRuntimeSettings = { ...DEFAULT_SETTINGS };

export function getLlmRuntimeSettings(): LlmRuntimeSettings {
  return { ...settings };
}

/** 对外可见的设置视图：apiKey 换成掩码与存在标记。 */
export function publicLlmSettings(): Omit<LlmRuntimeSettings, "apiKey"> & { apiKeyMasked: string; hasApiKey: boolean } {
  const { apiKey, ...rest } = settings;
  return { ...rest, apiKeyMasked: maskSecret(apiKey), hasApiKey: apiKey.length > 0 };
}

/** 密钥掩码：头尾各留一段，中间定长星号；空串 = 无密钥。 */
export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 3)}${"*".repeat(8)}${secret.slice(-4)}`;
}

/** 部分更新：未提供的字段保持不变，空串 = 清除该项并回落 `.env`。 */
export function setLlmRuntimeSettings(partial: Partial<Omit<LlmRuntimeSettings, "thinking">> & { thinking?: LlmRuntimeSettings["thinking"] }): LlmRuntimeSettings {
  for (const key of TEXT_KEYS) {
    const value = partial[key];
    if (typeof value === "string") settings[key] = value.trim();
  }
  for (const key of PRICING_KEYS) {
    const normalized = partial[key] === undefined ? undefined : normalizeRate(partial[key]);
    if (normalized !== undefined) settings[key] = normalized;
  }
  const timeoutMs = partial.timeoutMs === undefined ? undefined : normalizeTimeoutMs(partial.timeoutMs);
  if (timeoutMs !== undefined) settings.timeoutMs = timeoutMs;
  if (partial.thinking !== undefined) settings.thinking = partial.thinking;
  persist();
  return getLlmRuntimeSettings();
}

/** 启动时从磁盘恢复，须早于 `buildLlmRuntimeProvider`。 */
export function restoreLlmRuntimeSettings(): LlmRuntimeSettings {
  const file = settingsFile();
  if (!existsSync(file)) return getLlmRuntimeSettings();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const next = { ...DEFAULT_SETTINGS };
    for (const key of TEXT_KEYS) {
      if (typeof parsed[key] === "string") next[key] = (parsed[key] as string).trim();
    }
    const thinking = parsed.thinking;
    if (typeof thinking === "string" && (THINKING_EFFORTS as readonly string[]).includes(thinking)) next.thinking = thinking as LlmRuntimeSettings["thinking"];
    // 不合格的单价丢掉该项
    for (const key of PRICING_KEYS) {
      const normalized = normalizeRate(parsed[key]);
      if (normalized !== undefined) next[key] = normalized;
    }
    const timeoutMs = normalizeTimeoutMs(parsed.timeoutMs);
    if (timeoutMs !== undefined) next.timeoutMs = timeoutMs;
    settings = next;
  } catch (error) {
    // 损坏的设置文件按未配置处理，保留内存态
    console.warn(`[llm] 设置文件解析失败，按未配置处理：path=${file} error=${String(error)}`);
  }
  return getLlmRuntimeSettings();
}

/** 实际生效的配置；密钥只以 `hasApiKey` 出现。 */
export function effectiveLlmConfig(): Omit<ResolvedLlmConfig, "apiKey"> & { hasApiKey: boolean } {
  const { apiKey, ...config } = resolveLlmConfig(toOverrides(settings));
  return { ...config, hasApiKey: Boolean(apiKey) };
}

/** 当前设置转成工厂覆盖项；空串字段由 provider.ts 回落处理。 */
function toOverrides(current: LlmRuntimeSettings): LlmConfigOverrides {
  return { provider: current.provider, model: current.model, baseUrl: current.baseUrl, apiKey: current.apiKey, timeoutMs: current.timeoutMs };
}

function persist(): void {
  const file = settingsFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // writeFileSync 的 mode 只在创建时生效
    chmodSync(file, 0o600);
  } catch (error) {
    console.warn(`[llm] 设置没能落盘（本次会话仍生效，重启后回落 .env）：path=${file} error=${String(error)}`);
  }
}

/** 同一套配置的两个运行时角色。 */
export type LlmRole = "teaching" | "light";

/** 按角色装配 provider：`"light"` 强制关思考，`"teaching"` 用运行时设置里的档位。 */
export function buildLlmRuntimeProvider(role: LlmRole): LlmProvider | undefined {
  const raw = createLlmProvider(toOverrides(settings));
  return raw ? new ThinkingOverrideLlmProvider(new LoggingLlmProvider(raw, role), role === "light" ? "off" : settings.thinking) : undefined;
}
