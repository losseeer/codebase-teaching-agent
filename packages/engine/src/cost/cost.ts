import type { CostBucket, CostComponent, CostDay, CostSummary } from "@codebase-tutor/contract";
import type { JournalEvent } from "@codebase-tutor/domain";

import { getLlmRuntimeSettings } from "../llm/runtime.js";
import { readJournal } from "../persistence/journal.js";

export const defaultMonthlyBudgetUsd = 5;

/**
  三档单价：输入按「未命中 / 缓存命中」分别计价，输出单独一档。
  币种不参与算术：tokens × 单价 ÷ 一百万，填哪种币就算出哪种币。
  命中价没单独配置时按输入价计——不打折宁可高估，不能把真花掉的钱说少了。
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

/** 三档各自对应的 `.env` 名：currentPricing 与 pricingSourceOf 共用这一份映射，回落链只写一处。 */
const ENV_RATE_KEYS = { input: "TUTOR_INPUT_USD_PER_MILLION", cacheHit: "TUTOR_CACHE_HIT_USD_PER_MILLION", output: "TUTOR_OUTPUT_USD_PER_MILLION" } as const;

/**
  现在生效的三档单价：运行时设置（LLM 配置框里的单价）→ `.env` → 未配（0）；空串 = 该项回落环境变量。
  必须每次现读，不能是模块加载时算一次的常量：界面上改了价，按老数算账等于账面与闸门都不认新价。
  summarizeCost、预算闸门、启动告警与导入清单的读数都从这一处出发。
  */
export function currentPricing(): Pricing {
  const live = getLlmRuntimeSettings();
  return {
    inputPerMillionUsd: rateOf(live.inputUsdPerMillion) ?? rateOf(process.env[ENV_RATE_KEYS.input]) ?? 0,
    cacheHitPerMillionUsd: rateOf(live.cacheHitUsdPerMillion) ?? rateOf(process.env[ENV_RATE_KEYS.cacheHit]),
    outputPerMillionUsd: rateOf(live.outputUsdPerMillion) ?? rateOf(process.env[ENV_RATE_KEYS.output]) ?? 0
  };
}

/** 某一档现在由谁给出（界面 / .env / 未配）：成本页要说清「这数是从哪来的」，不然改了界面却看见 .env 的值会以为没生效。 */
export function pricingSourceOf(key: "input" | "output" | "cacheHit"): "runtime" | "env" | "unset" {
  const live = getLlmRuntimeSettings();
  const field = key === "input" ? live.inputUsdPerMillion : key === "output" ? live.outputUsdPerMillion : live.cacheHitUsdPerMillion;
  if (rateOf(field) !== undefined) return "runtime";
  return rateOf(process.env[ENV_RATE_KEYS[key]]) !== undefined ? "env" : "unset";
}

/**
  预算闸门的开关：三档单价里是否至少有一档可用。全零单价 ⇒ 钱恒为 0 ⇒ 永远判 "normal"，
  所有「超预算回落本地规则」的分支一起静默放行。判据只留这一处，读数、告警与界面文案都从这里出发。
  */
export function pricingIsConfigured(pricing: Pricing = currentPricing()): boolean {
  return pricing.inputPerMillionUsd > 0 || (pricing.cacheHitPerMillionUsd ?? 0) > 0 || pricing.outputPerMillionUsd > 0;
}

/**
  闸门失效时该说的那句话；闸门在管事时返回 undefined。
  句子里不带预算数字：它会在不读每仓 settings 的场合出现，写死一个数就对配过别的预算的仓不准；
  数字由 monthlyBudgetUsd 自己在成本页显示。
  */
export function budgetGateNotice(pricing: Pricing = currentPricing()): string | undefined {
  if (pricingIsConfigured(pricing)) return undefined;
  // 一句因果链读完即可；环境变量名交给界面的悬停说明
  return "没配单价时算不出花了多少，额度上限不会触发；配上任一单价即恢复。";
}

/** 把用量切成三个计费档位。输入口径与 provider 的 prompt_tokens 一致：命中那部分含在输入里。 */
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
  // 月份边界按 UTC 取（journal 的 at 就是 ISO UTC 串，两侧同一口径）：换成本地时区会让跨月那几天的「本月」与写入侧对不上
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
    // 闸门有没有在管事必须一起交出去，否则页面那句「本月 ¥0.0000」看着像真的没花钱（判据见 pricingIsConfigured）
    pricingConfigured: pricingIsConfigured(pricing),
    // mode:"degraded" 的行是存量历史写法（现在超预算直接在开火前 422，不再写这种行）；减法照旧，去掉会把那些免费回合算成付过钱
    degradedTurns: events.filter((event) => event.payload.mode === "degraded").length,
    byScene: bucket(events, (event) => typeof event.payload.scene === "string" ? event.payload.scene : "unknown"),
    byProvider: bucket(events, (event) => typeof event.payload.provider === "string" ? event.payload.provider : "unknown"),
    byDay: days(events)
  };
}

/**
  预算闸的唯一判据：本月已花的钱 ≥ 该仓预算就算降级（即 summarizeCost 的 mode === "degraded"）。
  判据只留这一处，各入口分抄会出现「导入放行而对话 422」的分岔。
  单价没配时钱恒算 0 ⇒ 永远不降级：那是闸门失效，由 budgetGateNotice 说明，这条判据不伪装成「额度还很宽」。
  */
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

/** 只列出有用量的日期，按日升序：近期条形图不需要把整月 31 天都占上。 */
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
