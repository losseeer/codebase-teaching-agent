import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LoggingLlmProvider } from "./call-log.js";
import { createLlmProvider, resolveLlmConfig, ThinkingOverrideLlmProvider, type LlmConfigOverrides, type LlmProvider, type ResolvedLlmConfig, type ThinkingEffort } from "./provider.js";

/**
  LLM 运行时设置（GUI 可改，落盘到 ~/.codebase-tutor/llm-settings.json，重启后仍在）。
  **只有一套配置**（2026-09-18 起不再有 teaching / light 两个配置槽）：
  - provider / model / baseUrl / apiKey：空串 = 该项回落 .env（.env 是降级策略，不是被摒弃）；
  - thinking：深任务（三作用域对话、流程生成）的思考档位，"auto" = 不发思考字段（模型默认，
    DeepSeek V4 默认开启思考）。
  「轻任务 / 教学对话」是**运行时角色**而非两份配置，见 buildLlmRuntimeProvider。

  密钥口径：apiKey 明文只存在于本模块的内存态与那个 0600 的文件里，**任何对外响应走 publicLlmSettings()**
  （只有掩码），路由层拿不到明文就不可能顺手 spread 出去。
  */
export interface LlmRuntimeSettings {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  thinking: "auto" | ThinkingEffort;
}

/** GUI 可选的服务商协议（与 provider.ts 的工厂分支一一对应）；空串另意为「回落 .env」。 */
export const LLM_PROVIDERS = ["openai-compatible", "openai", "anthropic", "ollama"] as const;

/** 可选思考档位（"auto" = 不发字段）；PUT 校验与磁盘恢复都按这份清单，错误文案不会再和判据走散。 */
export const THINKING_EFFORTS = ["auto", "off", "low", "high", "max"] as const;

const DEFAULT_SETTINGS: LlmRuntimeSettings = { provider: "", model: "", baseUrl: "", apiKey: "", thinking: "auto" };

/** 默认 ~/.codebase-tutor/llm-settings.json，测试用 TUTOR_LLM_SETTINGS_FILE 指向临时文件。 */
function settingsFile(): string {
  return process.env.TUTOR_LLM_SETTINGS_FILE ?? join(homedir(), ".codebase-tutor", "llm-settings.json");
}

let settings: LlmRuntimeSettings = { ...DEFAULT_SETTINGS };

export function getLlmRuntimeSettings(): LlmRuntimeSettings {
  return { ...settings };
}

/** 对外可见的设置视图：apiKey 换成掩码与存在标记，其余字段原样。 */
export function publicLlmSettings(): Omit<LlmRuntimeSettings, "apiKey"> & { apiKeyMasked: string; hasApiKey: boolean } {
  const { apiKey, ...rest } = settings;
  return { ...rest, apiKeyMasked: maskSecret(apiKey), hasApiKey: apiKey.length > 0 };
}

/**
  密钥掩码：只露头尾各一小段，中间用定长星号（长度不敏感，避免把 key 长度也泄露出去）。
  空串 = 没有运行时密钥（GUI 占位符改用 .env 侧的掩码或「未配置」）。
  */
export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 3)}${"*".repeat(8)}${secret.slice(-4)}`;
}

/** 部分更新（未提供的字段保持不变，空串 = 清除该项并回落 .env）；文本字段 trim，thinking 合法性由路由层先校验。 */
export function setLlmRuntimeSettings(partial: Partial<Omit<LlmRuntimeSettings, "thinking">> & { thinking?: LlmRuntimeSettings["thinking"] }): LlmRuntimeSettings {
  for (const key of ["provider", "model", "baseUrl", "apiKey"] as const) {
    const value = partial[key];
    if (typeof value === "string") settings[key] = value.trim();
  }
  if (partial.thinking !== undefined) settings.thinking = partial.thinking;
  persist();
  return getLlmRuntimeSettings();
}

/** 启动时从磁盘恢复（引擎 boot 里必须早于 buildLlmRuntimeProvider）。文件缺失/损坏按「未配置」处理，不阻断启动。 */
export function restoreLlmRuntimeSettings(): LlmRuntimeSettings {
  const file = settingsFile();
  if (!existsSync(file)) return getLlmRuntimeSettings();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const next = { ...DEFAULT_SETTINGS };
    for (const key of ["provider", "model", "baseUrl", "apiKey"] as const) {
      if (typeof parsed[key] === "string") next[key] = (parsed[key] as string).trim();
    }
    const thinking = parsed.thinking;
    if (typeof thinking === "string" && (THINKING_EFFORTS as readonly string[]).includes(thinking)) next.thinking = thinking as LlmRuntimeSettings["thinking"];
    settings = next;
  } catch {
    // 损坏的设置文件按未配置处理：保留内存态，下次保存会整体覆盖
  }
  return getLlmRuntimeSettings();
}

/** 实际生效的配置（GUI 覆盖 → .env → 协议默认）；密钥不外泄，只以 `hasApiKey` 出现。 */
export function effectiveLlmConfig(): Omit<ResolvedLlmConfig, "apiKey"> & { hasApiKey: boolean } {
  const { apiKey, ...config } = resolveLlmConfig(toOverrides(settings));
  return { ...config, hasApiKey: Boolean(apiKey) };
}

/** 当前设置作为工厂覆盖项（空串字段由 provider.ts 的三层回落处理）。 */
function toOverrides(current: LlmRuntimeSettings): LlmConfigOverrides {
  return { provider: current.provider, model: current.model, baseUrl: current.baseUrl, apiKey: current.apiKey };
}

function persist(): void {
  const file = settingsFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // mode 只在创建时生效：文件若已存在且是 644（别的工具写过），这里补一次
    chmodSync(file, 0o600);
  } catch {
    // 落盘失败不影响本次会话生效：内存态与 provider 已经更新，只是重启后会回落 .env
  }
}

/** 同一套配置的两个运行时角色；llm.log 的 tier 仍按角色记账，方便区分深浅任务的成本。 */
export type LlmRole = "teaching" | "light";

/**
  - "teaching"：三作用域对话、流程生成等深任务——思考档位随运行时设置；
  - "light"：推荐入口 / 题面润色 / 命名 / L1 摘要等单轮浅任务——思考强制 "off"
    （这是行为约定，不是第二份配置；开了思考只会白烧 reasoning token，2026-09-15 实测教训）。
  */
export function buildLlmRuntimeProvider(role: LlmRole): LlmProvider | undefined {
  const raw = createLlmProvider(toOverrides(settings));
  return raw ? new ThinkingOverrideLlmProvider(new LoggingLlmProvider(raw, role), role === "light" ? "off" : settings.thinking) : undefined;
}
