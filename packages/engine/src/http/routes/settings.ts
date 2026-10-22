import { readRepositorySettings } from "../../application/paid-turn.js";
import { currentPricing, pricingSourceOf, summarizeCost } from "../../cost/cost.js";
import { resolveLlmConfig, teachingProviderStatus } from "../../llm/provider.js";
import { LLM_PROVIDERS, PRICING_KEYS, THINKING_EFFORTS, effectiveLlmConfig, getLlmRuntimeSettings, normalizeRate, publicLlmSettings, setLlmRuntimeSettings } from "../../llm/runtime.js";
import { isThinkingEffortSupported, resolveThinkingCapability, supportedThinkingEfforts } from "../../llm/thinking.js";
import { REPOSITORY_NOT_MOUNTED, repositoryOr404, teachingLlm } from "../../services.js";
import type { FastifyInstance } from "fastify";

/**
  配置与成本面：运行时 LLM 设置（全局，含密钥掩码）、每仓预算、成本读数。
  它们共用同一套口径：单价、预算、`pricingSourceOf` 的来源说明。
 */
export function registerSettingsRoutes(app: FastifyInstance): void {
/** 生效模型的思考能力声明（按实际生效 slug 解析，随 GET/PUT /api/llm/settings 返回给 GUI）。 */
function describeThinking(model: string): { model: string; style: ReturnType<typeof resolveThinkingCapability>["style"]; efforts: string[] } {
  const capability = resolveThinkingCapability(model);
  return { model, style: capability.style, efforts: supportedThinkingEfforts(capability) };
}

/** GET/PUT 共用的响应装配：运行时设置（密钥只以掩码出现）+ .env 回落值 + 生效状态 + 思考能力声明。 */
function llmSettingsPayload(): Record<string, unknown> {
  // envFallback 用「无任何覆盖」解析一次，得到纯 .env（+ 协议默认）的口径，GUI 才能把空字段说明成「留空 = 用 .env 的 xxx」
  const fallback = resolveLlmConfig({});
  const active = teachingProviderStatus(teachingLlm());
  return {
    ...publicLlmSettings(),
    envFallback: { provider: fallback.provider, model: fallback.model, baseUrl: fallback.baseUrl, hasApiKey: Boolean(fallback.apiKey) },
    /** 单价：现在生效值 + 每一档从哪来。界面上留空那一档显示的是 .env 的数，不说清来源就成了没法自查的读数。 */
    pricing: currentPricing(),
    pricingSources: { input: pricingSourceOf("input"), output: pricingSourceOf("output"), cacheHit: pricingSourceOf("cacheHit") },
    activeModel: active.model,
    activeProvider: active.provider,
    activeMode: active.mode,
    // 能力按「实际生效的模型 slug」解析（运行时覆盖优先，回落 .env），与 provider 工厂同一套解析
    thinkingCapability: describeThinking(effectiveLlmConfig().model)
  };
}

/**
  GUI 运行时 LLM 设置：读取（含 .env 回落值、预设模型清单与生效模型的思考能力声明）。
  这一份配置是全局的（服务商 / 端点 / 密钥影响每一次出网），所以它是管理面。
  */
app.get("/api/llm/settings", async () => llmSettingsPayload());

/** GUI 运行时 LLM 设置：更新服务商/模型/端点/密钥/思考档位/单价，立即重建 provider 并落盘（留空 = 回落 .env） */
app.put<{ Body: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; thinking?: string; inputUsdPerMillion?: string; outputUsdPerMillion?: string; cacheHitUsdPerMillion?: string } }>("/api/llm/settings", async (request, reply) => {
  const body = request.body ?? {};
  if (body.thinking !== undefined && !(THINKING_EFFORTS as readonly string[]).includes(body.thinking)) {
    return reply.code(422).send({ error: `thinking 只支持 ${THINKING_EFFORTS.join(" / ")}` });
  }
  const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : undefined;
  if (provider !== undefined && provider !== "" && !(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    return reply.code(422).send({ error: `服务商只支持 ${LLM_PROVIDERS.join(" / ")}（留空 = 用 .env）` });
  }
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : undefined;
  if (baseUrl) {
    // 只认 http(s)：填了 file:// 之类的协议会在 fetch 时以晦涩错误失败，不如在保存时就拒绝
    let protocol = "";
    try {
      protocol = new URL(baseUrl).protocol;
    } catch {
      return reply.code(422).send({ error: "接口地址不是合法 URL（需带 http:// 或 https:// 前缀）" });
    }
    if (protocol !== "http:" && protocol !== "https:") return reply.code(422).send({ error: "接口地址只接受 http:// 或 https://" });
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
  // 密钥里的空白几乎总是粘贴带进来的换行，存下来只会变成「401 但看不出为什么」
  if (apiKey !== undefined && /\s/.test(apiKey)) return reply.code(422).send({ error: "API Key 不能含空格或换行" });

  /**
    单价三档：留空 = 该项回落 .env，非负数才收。必须当场拒绝而不是「存下来再说」——
    这两个值会一路流进成本读数和预算闸门（`currentPricing()`），一个 "-3" 或 "abc" 存进去，
    算出的就是负钱或 NaN，而闸门按「钱 ≥ 预算」判断，NaN 恒为 false ⇒ 静默变成「永不超支」。
    判据与落盘恢复共用 `normalizeRate`。
    */
  const PRICING_LABELS: Record<(typeof PRICING_KEYS)[number], string> = {
    inputUsdPerMillion: "输入单价",
    outputUsdPerMillion: "输出单价",
    cacheHitUsdPerMillion: "缓存命中单价"
  };
  const pricingPatch: Partial<Record<(typeof PRICING_KEYS)[number], string>> = {};
  for (const key of PRICING_KEYS) {
    const raw = body[key];
    if (raw === undefined) continue;
    const normalized = normalizeRate(raw);
    if (normalized === undefined) return reply.code(422).send({ error: `${PRICING_LABELS[key]}得是不小于 0 的数字（人民币 / 百万 token），留空表示用 .env 的值`, reason: "pricing_invalid" });
    pricingPatch[key] = normalized;
  }

  // 思考档位与（新）服务商 / 模型的兼容性提前校验：不支持的组合在保存时就拒绝，而不是等每次对话调用时报错。
  // off 豁免：none/unknown 模型的 off = 不发字段（恒可表达，与 applyThinking 语义一致），不能被这里 422 掉。
  if (body.thinking && body.thinking !== "auto") {
    const model = resolveLlmConfig({ ...getLlmRuntimeSettings(), ...(provider === undefined ? {} : { provider }), ...(typeof body.model === "string" ? { model: body.model } : {}) }).model;
    if (!isThinkingEffortSupported(model, body.thinking as "auto" | "off" | "low" | "high" | "max")) {
      const supported = supportedThinkingEfforts(resolveThinkingCapability(model));
      return reply.code(422).send({ error: `模型 ${model} 不支持思考档位 "${body.thinking}"（支持：${supported.length ? supported.join("/") : "无"}）` });
    }
  }
  setLlmRuntimeSettings({
    ...(provider === undefined ? {} : { provider }),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...pricingPatch,
    thinking: body.thinking as never
  });
  // 响应带生效状态与能力声明：GUI 换模型 / 换服务商后无需再 GET 一次就能刷新思考档位的可用状态。
  // 换到「缺密钥」的组合时建不出 provider（activeMode=local），这不算请求失败，把状态如实回给 GUI。
  return llmSettingsPayload();
});

app.get<{ Params: { repositoryId: string }; Querystring: { sessionId?: string } }>("/api/repositories/:repositoryId/cost", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  return summarizeCost(repository.path, readRepositorySettings(repository.handle).monthlyBudgetUsd, request.query.sessionId);
});

app.put<{ Params: { repositoryId: string }; Body: { monthlyBudgetUsd?: number } }>("/api/repositories/:repositoryId/settings", async (request, reply) => {
  const repository = repositoryOr404(request.params.repositoryId);
  if (!repository) return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
  const budget = request.body?.monthlyBudgetUsd;
  if (budget === undefined) return reply.code(400).send({ error: "请提供 monthlyBudgetUsd" });
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) return reply.code(400).send({ error: "预算必须是非负数字" });
  const database = repository.handle.pin();
  try {
    // 读-合并-写：settings_json 里还存着 refinement 标记等内部键，整体覆盖会把它们清除
    const stored = database.getSettings<{ monthlyBudgetUsd?: number; refinement?: unknown }>(repository.index.repositoryId) ?? {};
    database.saveSettings(repository.index.repositoryId, { ...stored, monthlyBudgetUsd: budget });
  } finally {
    repository.handle.unpin();
  }
  const next = readRepositorySettings(repository.handle);
  return { ...summarizeCost(repository.path, next.monthlyBudgetUsd), settings: next };
});
}
