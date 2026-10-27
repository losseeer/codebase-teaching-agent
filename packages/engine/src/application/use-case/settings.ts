import { readRepositorySettings } from "../paid-turn.js";
import { currentPricing, pricingSourceOf, summarizeCost } from "../../cost/cost.js";
import { resolveLlmConfig, teachingProviderStatus, TIMEOUT_MAX_MS, TIMEOUT_MIN_MS } from "../../llm/provider.js";
import { LLM_PROVIDERS, PRICING_KEYS, THINKING_EFFORTS, effectiveLlmConfig, getLlmRuntimeSettings, normalizeRate, normalizeTimeoutMs, publicLlmSettings, setLlmRuntimeSettings } from "../../llm/runtime.js";
/** 思考档位取值：以运行时那份清单为唯一真源，不在这里另抄一份。 */
type ThinkingEffort = (typeof THINKING_EFFORTS)[number];
import { isThinkingEffortSupported, resolveThinkingCapability, supportedThinkingEfforts } from "../../llm/thinking.js";
import { repositoryOr404, teachingLlm } from "../../services.js";

/**
  配置与成本面的用例：运行时 LLM 设置（全局，含密钥掩码）、每仓预算、成本读数。
  三条共用同一套口径：单价、预算、`pricingSourceOf` 的来源说明。

  哪些值可以存下来，是这里的判断而不是传输层的：
  - 单价三档必须当场拒——这两个值一路流进成本读数与预算闸门，存进 "-3" 或 "abc" 就算出负钱或 NaN，
    而闸门按「钱 ≥ 预算」判断，NaN 恒为 false ⇒ 静默变成「永不超支」；判据与落盘恢复共用 `normalizeRate`；
  - 接口地址只认 http(s)：填了 file:// 之类的协议会在 fetch 时以晦涩错误失败，不如在保存时就拒绝；
  - 密钥里的空白几乎总是粘贴带进来的换行，存下来只会变成「401 但看不出为什么」；
  - 超时按区间拒（1 秒~5 分钟）而不是钳下来收下：填 999999 的人以为自己有很多时间，实际连不上时要连等两发；
    这一档原本是只能改 `.env` 再重启的旋钮，而模型侧那句「可以调大超时时长」一直在指它；
  - 思考档位与新服务商/模型的兼容性提前校验，不支持的组合在保存时就拒，而不是等每次对话调用时报错。
    `off` 豁免：none/unknown 模型的 off = 不发字段（恒可表达，与 applyThinking 语义一致），不能被这里拒掉。
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

/** 生效模型的思考能力声明（按实际生效 slug 解析，随设置读写一起回给界面）。 */
function describeThinking(model: string) {
  const capability = resolveThinkingCapability(model);
  return { model, style: capability.style, efforts: supportedThinkingEfforts(capability) };
}

/**
  GET/PUT 共用的响应装配：运行时设置（密钥只以掩码出现）+ .env 回落值 + 生效状态 + 思考能力声明。
  envFallback 用「无任何覆盖」解析一次，得到纯 .env（+ 协议默认）的口径，界面才能把空字段说明成「留空 = 用 .env 的 xxx」。
  换到「缺密钥」的组合时建不出 provider（activeMode=local），这不算失败，把状态如实回出去。
  */
export function llmSettingsView(): Record<string, unknown> {
  const fallback = resolveLlmConfig({});
  const effective = effectiveLlmConfig;
  const active = teachingProviderStatus(teachingLlm());
  return {
    ...publicLlmSettings(),
    // 超时这里给的是「.env 那一份解析完的结果」：界面要能说清留空时实际生效的是多少毫秒
    envFallback: { provider: fallback.provider, model: fallback.model, baseUrl: fallback.baseUrl, hasApiKey: Boolean(fallback.apiKey), timeoutMs: fallback.timeoutMs },
    pricing: currentPricing(),
    pricingSources: { input: pricingSourceOf("input"), output: pricingSourceOf("output"), cacheHit: pricingSourceOf("cacheHit") },
    activeModel: active.model,
    activeProvider: active.provider,
    activeMode: active.mode,
    // 生效超时与能力都按「运行时覆盖优先，回落 .env」这一套解析，与 provider 工厂同一口径
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
  // 响应带生效状态与能力声明：界面换模型/换服务商后无需再 GET 一次就能刷新思考档位的可用状态。
  return { ok: true, value: llmSettingsView() };
}

/** 成本读数：按整月聚合，`sessionId` 给了就把这一条线程的花费单列出来。 */
export function readCostUseCase(repositoryId: string, sessionId?: string): SettingsResult<ReturnType<typeof summarizeCost>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missingRepo;
  return { ok: true, value: summarizeCost(repository.path, readRepositorySettings(repository.handle).monthlyBudgetUsd, sessionId) };
}

/** 改每仓月预算：读-合并-写，`settings_json` 里还存着 refinement 标记等内部键，整体覆盖会把它们清除。 */
export function saveBudgetUseCase(repositoryId: string, monthlyBudgetUsd: unknown): SettingsResult<Record<string, unknown>> {
  const repository = repositoryOr404(repositoryId);
  if (!repository) return missingRepo;
  if (monthlyBudgetUsd === undefined) return { ok: false, failure: { kind: "budget-missing" } };
  if (typeof monthlyBudgetUsd !== "number" || !Number.isFinite(monthlyBudgetUsd) || monthlyBudgetUsd < 0) return { ok: false, failure: { kind: "budget-invalid" } };
  const database = repository.handle.pin();
  try {
    const stored = database.getSettings<{ monthlyBudgetUsd?: number; refinement?: unknown }>(repository.index.repositoryId) ?? {};
    database.saveSettings(repository.index.repositoryId, { ...stored, monthlyBudgetUsd });
  } finally {
    repository.handle.unpin();
  }
  const next = readRepositorySettings(repository.handle);
  return { ok: true, value: { ...summarizeCost(repository.path, next.monthlyBudgetUsd), settings: next } };
}
