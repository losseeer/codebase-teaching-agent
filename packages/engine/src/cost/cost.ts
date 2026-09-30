import type { CostBucket, CostComponent, CostDay, CostSummary, JournalEvent } from "@codebase-tutor/shared";
import { readJournal } from "../store/journal.js";

export const defaultMonthlyBudgetUsd = 5;

/**
  三档单价：输入按「未命中 / 缓存命中」分别计价，输出单独一档。
  命中价没单独配置时**按输入价计**——不打折宁可高估，也不能把真花掉的钱说少了。
  （DeepSeek 这类端点命中价通常是输入价的 1/10，想要准确账面就显式配上。）
  */
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

export const envPricing: Pricing = {
  inputPerMillionUsd: rateOf(process.env.TUTOR_INPUT_USD_PER_MILLION) ?? 0,
  cacheHitPerMillionUsd: rateOf(process.env.TUTOR_CACHE_HIT_USD_PER_MILLION),
  outputPerMillionUsd: rateOf(process.env.TUTOR_OUTPUT_USD_PER_MILLION) ?? 0
};

/** 把用量切成三个计费档位。输入口径与 provider 的 `prompt_tokens` 一致：命中那部分**含在**输入里。 */
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

export function summarizeCost(repositoryPath: string, monthlyBudgetUsd = defaultMonthlyBudgetUsd, sessionId?: string, pricing: Pricing = envPricing): CostSummary {
  const month = new Date().toISOString().slice(0, 7);
  const events = readJournal(repositoryPath).filter((event) => event.type === "token_usage" && event.at.startsWith(month) && (!sessionId || event.sessionId === sessionId));
  const inputTokens = sum(events, "input_tokens");
  const outputTokens = sum(events, "output_tokens");
  // 逐条夹到不超过该回合的输入，再求和：某端点把命中数报到输入之外时，账面不会出现负数输入
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
    // 三档单价全没配时金额恒为 0——这个事实要一起交出去，否则页面一句「本月 $0.0000」看着像真的没花钱
    pricingConfigured: pricing.inputPerMillionUsd > 0 || (pricing.cacheHitPerMillionUsd ?? 0) > 0 || pricing.outputPerMillionUsd > 0,
    degradedTurns: events.filter((event) => event.payload.mode === "degraded").length,
    byScene: bucket(events, (event) => typeof event.payload.scene === "string" ? event.payload.scene : "unknown"),
    byProvider: bucket(events, (event) => typeof event.payload.provider === "string" ? event.payload.provider : "unknown"),
    byDay: days(events)
  };
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

/** 只列出有用量的日期，按日升序：近期条形图不需要把整月 31 格都占上。 */
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
