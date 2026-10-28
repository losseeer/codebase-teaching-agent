import { readRepositorySettings } from "../orchestration/paid-turn.js";
import { currentPricing, pricingSourceOf, summarizeCost } from "../../cost/cost.js";
import { resolveLlmConfig, teachingProviderStatus, TIMEOUT_MAX_MS, TIMEOUT_MIN_MS } from "../../adapter/outbound/llm/provider.js";
import { LLM_PROVIDERS, PRICING_KEYS, THINKING_EFFORTS, effectiveLlmConfig, getLlmRuntimeSettings, normalizeRate, normalizeTimeoutMs, publicLlmSettings, setLlmRuntimeSettings } from "../../adapter/outbound/llm/runtime.js";
/** 思考档位取值 = 运行时清单的成员。 */
type ThinkingEffort = (typeof THINKING_EFFORTS)[number];
import { isThinkingEffortSupported, resolveThinkingCapability, supportedThinkingEfforts } from "../../adapter/outbound/llm/thinking.js";
import { repositoryOr404, teachingLlm } from "../../infrastructure/composition-root.js";

/**
  配置与成本面的用例：运行时 LLM 设置（含密钥掩码）、每仓预算、成本读数。
  哪些值能存下来在这里判：单价当场拒非法值、接口地址只认 http(s)、超时按区间拒、思考档位提前校验兼容性。
*/
export type SettingsFailure =
  | { kind: "repository-missing" }
  | { kind: "thinking-unsupported"; thinking: string }
  | { kind: "provider-unsupported" }
  | { kind: "url-malformed" }
  | { kind: "url-protocol" }
  | { kind: "api-key-blank" }
  | { kind: "pricing-invalid"; label: string }
  | { kind: "timeout-invalid" }
  | { kind: "model-thinking-incompatible"; model: string; thinking: string; supported: string[] }
  | { kind: "budget-missing" }
  | { kind: "budget-invalid" };

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; failure: SettingsFailure };

const PRICING_LABELS: Record<(typeof PRICING_KEYS)[number], string> = {
  inputUsdPerMillion: "输入单价",
  outputUsdPerMillion: "输出单价",
  cacheHitUsdPerMillion: "缓存命中单价"
};

const missingRepo: SettingsResult<never> = { ok: false, failure: { kind: "repository-missing" } };

/** 生效模型的思考能力声明。 */
function describeThinking(model: string) {
  const capability = resolveThinkingCapability(model);
  return { model, style: capability.style, efforts: supportedThinkingEfforts(capability) };
}

/** GET/PUT 共用的响应装配：运行时设置（密钥只出掩码）+ .env 回落值 + 生效状态 + 思考能力声明。 */
export function llmSettingsView(): Record<string, unknown> {
  const fallback = resolveLlmConfig({});
  const effective = effectiveLlmConfig;
  const active = teachingProviderStatus(teachingLlm());
  return {
    ...publicLlmSettings(),
    envFallback: { provider: fallback.provider, model: fallback.model, baseUrl: fallback.baseUrl, hasApiKey: Boolean(fallback.apiKey), timeoutMs: fallback.timeoutMs },
    pricing: currentPricing(),
    pricingSources: { input: pricingSourceOf("input"), output: pricingSourceOf("output"), cacheHit: pricingSourceOf("cacheHit") },
    activeModel: active.model,
    activeProvider: active.provider,
    activeMode: active.mode,
    // 生效超时与能力按「运行时覆盖优先，回落 .env」解析，与 provider 工厂同一口径。
    activeTimeoutMs: effective().timeoutMs,
    timeoutRange: { minMs: TIMEOUT_MIN_MS, maxMs: TIMEOUT_MAX_MS },
    thinkingCapability: describeThinking(effective().model)
  };
}

export interface LlmSettingsPatch {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  thinking?: string;
  inputUsdPerMillion?: string;
  outputUsdPerMillion?: string;
  cacheHitUsdPerMillion?: string;
  /** 单次请求的超时（毫秒）；空串 = 回落 .env 的 `TUTOR_LLM_TIMEOUT_MS`。 */
  timeoutMs?: string;
}

/** 更新服务商/模型/端点/密钥/思考档位/单价：校验通过才落盘并立即重建 provider，留空 = 回落 .env。 */
export function updateLlmSettingsUseCase(patch: LlmSettingsPatch): SettingsResult<Record<string, unknown>> {
  const body = patch ?? {};
  if (body.thinking !== undefined && !(THINKING_EFFORTS as readonly string[]).includes(body.thinking)) {
    return { ok: false, failure: { kind: "thinking-unsupported", thinking: body.thinking } };
  }
  const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : undefined;
  if (provider !== undefined && provider !== "" && !(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    return { ok: false, failure: { kind: "provider-unsupported" } };
  }
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : undefined;
  if (baseUrl) {
    let protocol = "";
    try {
      protocol = new URL(baseUrl).protocol;
    } catch {
      return { ok: false, failure: { kind: "url-malformed" } };
    }
    if (protocol !== "http:" && protocol !== "https:") return { ok: false, failure: { kind: "url-protocol" } };
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
  if (apiKey !== undefined && /\s/.test(apiKey)) return { ok: false, failure: { kind: "api-key-blank" } };

  const pricingPatch: Partial<Record<(typeof PRICING_KEYS)[number], string>> = {};
  for (const key of PRICING_KEYS) {
    const raw = body[key];
    if (raw === undefined) continue;
    const normalized = normalizeRate(raw);
    if (normalized === undefined) return { ok: false, failure: { kind: "pricing-invalid", label: PRICING_LABELS[key] } };
    pricingPatch[key] = normalized;
  }

  const timeoutMs = patch.timeoutMs === undefined ? undefined : normalizeTimeoutMs(patch.timeoutMs);
  if (patch.timeoutMs !== undefined && timeoutMs === undefined) return { ok: false, failure: { kind: "timeout-invalid" } };

  if (body.thinking && body.thinking !== "auto") {
    const model = resolveLlmConfig({ ...getLlmRuntimeSettings(), ...(provider === undefined ? {} : { provider }), ...(typeof body.model === "string" ? { model: body.model } : {}) }).model;
    if (!isThinkingEffortSupported(model, body.thinking as ThinkingEffort)) {
      return { ok: false, failure: { kind: "model-thinking-incompatible", model, thinking: body.thinking, supported: supportedThinkingEfforts(resolveThinkingCapability(model)) } };
    }
  }
  setLlmRuntimeSettings({
    ...(provider === undefined ? {} : { provider }),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...pricingPatch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    thinking: body.thinking as ThinkingEffort
  });
  return { ok: true, value: llmSettingsView() };
}

/** 成本读数：按整月聚合，`sessionId` 给了就把这一条线程的花费单列出来。 */
export function readCostUseCase(repositoryId: string, sessionId?: string): SettingsResult<ReturnType<typeof summarizeCost>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missingRepo;
  return { ok: true, value: summarizeCost(repository.path, readRepositorySettings(repository.handle).monthlyBudgetUsd, sessionId) };
}

/** 改每仓月预算：读-合并-写，保留 `settings_json` 里的内部键。 */
export function saveBudgetUseCase(repositoryId: string, monthlyBudgetUsd: unknown): SettingsResult<Record<string, unknown>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missingRepo;
  if (monthlyBudgetUsd === undefined) return { ok: false, failure: { kind: "budget-missing" } };
  if (typeof monthlyBudgetUsd !== "number" || !Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd < 0) return { ok: false, failure: { kind: "budget-invalid" } };
  const database = repository.handle.pin();
  try {
    const stored = database.state.settings<{ monthlyBudgetUsd?: number; refinement?: unknown }>(repository.index.repositoryId) ?? {};
    database.state.saveSettings(repository.index.repositoryId, { ...stored, monthlyBudgetUsd });
  } finally {
    repository.handle.unpin();
  }
  const next = readRepositorySettings(repository.handle);
  return { ok: true, value: { ...summarizeCost(repository.path, next.monthlyBudgetUsd), settings: next } };
}
