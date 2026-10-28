import type { CostBucket, CostComponent, CostDay, CostSummary } from "@codebase-tutor/contract";
import type { JournalEvent } from "@codebase-tutor/domain";

import { getLlmRuntimeSettings } from "../adapter/outbound/llm/runtime.js";
import { readJournal } from "../adapter/outbound/persistence/journal.js";

export const defaultMonthlyBudgetUsd = 5;

/** 三档单价：未命中输入、缓存命中输入、输出。 */
export interface Pricing {
  inputPerMillionUsd: number;
  cacheHitPerMillionUsd?: number;
  outputPerMillionUsd: number;
}

function rateOf(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** 三档单价对应的 `.env` 名。 */
const ENV_RATE_KEYS = { input: "TUTOR_INPUT_USD_PER_MILLION", cacheHit: "TUTOR_CACHE_HIT_USD_PER_MILLION", output: "TUTOR_OUTPUT_USD_PER_MILLION" } as const;

/** 当前生效的三档单价。 */
export function currentPricing(): Pricing {
  const live = getLlmRuntimeSettings();
  return {
    inputPerMillionUsd: rateOf(live.inputUsdPerMillion) ?? rateOf(process.env[ENV_RATE_KEYS.input]) ?? 0,
    cacheHitPerMillionUsd: rateOf(live.cacheHitUsdPerMillion) ?? rateOf(process.env[ENV_RATE_KEYS.cacheHit]),
    outputPerMillionUsd: rateOf(live.outputUsdPerMillion) ?? rateOf(process.env[ENV_RATE_KEYS.output]) ?? 0
  };
}

/** 某一档单价当前的来源：runtime / env / unset。 */
export function pricingSourceOf(key: "input" | "output" | "cacheHit"): "runtime" | "env" | "unset" {
  const live = getLlmRuntimeSettings();
  const field = key === "input" ? live.inputUsdPerMillion : key === "output" ? live.outputUsdPerMillion : live.cacheHitUsdPerMillion;
  if (rateOf(field) !== undefined) return "runtime";
  return rateOf(process.env[ENV_RATE_KEYS[key]]) !== undefined ? "env" : "unset";
}

/** 三档单价是否至少配置了一档。 */
export function pricingIsConfigured(pricing: Pricing = currentPricing()): boolean {
  return pricing.inputPerMillionUsd > 0 || (pricing.cacheHitPerMillionUsd ?? 0) > 0 || pricing.outputPerMillionUsd > 0;
}

/** 单价未配置时的提示文案。 */
export function budgetGateNotice(pricing: Pricing = currentPricing()): string | undefined {
  if (pricingIsConfigured(pricing)) return undefined;

  return "没配单价时算不出花了多少，额度上限不会触发；配上任一单价即恢复。";
}

/** 缓存命中数含在 `inputTokens` 内，与 provider 的 `prompt_tokens` 同口径。 */
export function priceComponents(usage: { inputTokens: number; cacheHitTokens: number; outputTokens: number }, pricing: Pricing): CostComponent[] {
  const hit = Math.max(0, Math.min(usage.inputTokens, usage.cacheHitTokens));
  const billedInput = Math.max(0, usage.inputTokens - hit);
  const hitRate = pricing.cacheHitPerMillionUsd ?? pricing.inputPerMillionUsd;
  const row = (label: CostComponent["label"], tokens: number, ratePerMillionUsd: number, rateFallback: boolean): CostComponent =>
    ({ label, tokens, ratePerMillionUsd, rateFallback, estimatedCostUsd: (tokens * ratePerMillionUsd) / 1_000_000 });
  return [
    row("未命中输入", billedInput, pricing.inputPerMillionUsd, false),
    row("命中输入（缓存）", hit, hitRate, pricing.cacheHitPerMillionUsd === undefined),
    row("输出", usage.outputTokens, pricing.outputPerMillionUsd, false)
  ];
}

export function summarizeCost(repositoryPath: string, monthlyBudgetUsd = defaultMonthlyBudgetUsd, sessionId?: string, pricing: Pricing = currentPricing()): CostSummary {
  // 月份边界按 UTC，与 journal 的 `at` 同口径
  const month = new Date().toISOString().slice(0, 7);
  const events = readJournal(repositoryPath).filter((event) => event.type === "token_usage" && event.at.startsWith(month) && (!sessionId || event.sessionId === sessionId));
  const inputTokens = sum(events, "input_tokens");
  const outputTokens = sum(events, "output_tokens");
  let cacheHitTokens = 0;
  for (const event of events) cacheHitTokens += Math.min(tokens(event, "input_tokens"), Math.max(0, tokens(event, "cache_hit_tokens")));
  const costComponents = priceComponents({ inputTokens, cacheHitTokens, outputTokens }, pricing);
  const estimatedCostUsd = costComponents.reduce((total, component) => total + component.estimatedCostUsd, 0);
  const remainingBudgetUsd = Math.max(0, monthlyBudgetUsd - estimatedCostUsd);
  return {
    sessionId,
    inputTokens,
    billedInputTokens: inputTokens - cacheHitTokens,
    cacheHitTokens,
    outputTokens,
    estimatedCostUsd,
    monthlyBudgetUsd,
    remainingBudgetUsd,
    mode: estimatedCostUsd >= monthlyBudgetUsd ? "degraded" : "normal",
    turns: events.length,
    costComponents,
    pricingConfigured: pricingIsConfigured(pricing),
    degradedTurns: events.filter((event) => event.payload.mode === "degraded").length,
    byScene: bucket(events, (event) => typeof event.payload.scene === "string" ? event.payload.scene : "unknown"),
    byProvider: bucket(events, (event) => typeof event.payload.provider === "string" ? event.payload.provider : "unknown"),
    byDay: days(events)
  };
}

/** 本月预估花费是否已达到该仓预算。 */
export function budgetExceeded(repositoryPath: string, monthlyBudgetUsd: number, sessionId?: string): boolean {
  return summarizeCost(repositoryPath, monthlyBudgetUsd, sessionId).mode === "degraded";
}

function bucket(events: JournalEvent[], labelOf: (event: JournalEvent) => string): CostBucket[] {
  const map = new Map<string, CostBucket>();
  for (const event of events) {
    const label = labelOf(event);
    const row = map.get(label) ?? { label, turns: 0, inputTokens: 0, outputTokens: 0 };
    row.turns += 1;
    row.inputTokens += tokens(event, "input_tokens");
    row.outputTokens += tokens(event, "output_tokens");
    map.set(label, row);
  }
  return [...map.values()].sort((left, right) => (right.inputTokens + right.outputTokens) - (left.inputTokens + left.outputTokens) || left.label.localeCompare(right.label));
}

/** 按日聚合的用量，仅包含有用量的日期。 */
function days(events: JournalEvent[]): CostDay[] {
  const map = new Map<string, CostDay>();
  for (const event of events) {
    const date = event.at.slice(0, 10);
    const row = map.get(date) ?? { date, inputTokens: 0, outputTokens: 0 };
    row.inputTokens += tokens(event, "input_tokens");
    row.outputTokens += tokens(event, "output_tokens");
    map.set(date, row);
  }
  return [...map.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function sum(events: JournalEvent[], key: string): number {
  return events.reduce((total, event) => total + tokens(event, key), 0);
}

function tokens(event: JournalEvent, key: string): number {
  const value = event.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
