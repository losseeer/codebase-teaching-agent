import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "../adapter/outbound/persistence/journal.js";
import { budgetGateNotice, currentPricing, defaultMonthlyBudgetUsd, priceComponents, pricingIsConfigured, pricingSourceOf, summarizeCost, type Pricing } from "./cost.js";
import { setLlmRuntimeSettings } from "../adapter/outbound/llm/runtime.js";

/** 单价由测试显式传入，不读机器上的环境变量。 */

const pricing: Pricing = { inputPerMillionUsd: 0.3, cacheHitPerMillionUsd: 0.03, outputPerMillionUsd: 0.6 };

describe("summarizeCost", () => {
  let repository: string;

  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-cost-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  it("按场景与 provider 分桶，回合数、缓存命中与降级回合各算各的", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("token_usage", { input_tokens: 900, output_tokens: 100, cache_hit_tokens: 400, provider: "deepseek-chat", scene: "teach" }, "thread_a");
    journal.append("token_usage", { input_tokens: 200, output_tokens: 50, cache_hit_tokens: 0, provider: "kimi-k2", scene: "map_chat" }, "thread_b");
    journal.append("token_usage", { input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0, provider: "local-heuristic-v1", scene: "teach", mode: "degraded", cause: "monthly_budget_reached" }, "thread_a");

    const summary = summarizeCost(repository, defaultMonthlyBudgetUsd, undefined, pricing);
    expect(summary.turns).toBe(3);
    expect(summary.inputTokens).toBe(1100);
    expect(summary.cacheHitTokens).toBe(400);
    expect(summary.billedInputTokens).toBe(700);
    expect(summary.outputTokens).toBe(150);
    expect(summary.degradedTurns).toBe(1);
    // 降级那一行也计入 turns，相减才是付了 token 的回合数。
    expect(summary.turns - summary.degradedTurns).toBe(2);
    expect(summary.byScene).toEqual([
      { label: "teach", turns: 2, inputTokens: 900, outputTokens: 100 },
      { label: "map_chat", turns: 1, inputTokens: 200, outputTokens: 50 }
    ]);
    expect(summary.byProvider.map((row) => row.label)).toEqual(["deepseek-chat", "kimi-k2", "local-heuristic-v1"]);
    expect(summary.byDay).toHaveLength(1);
    expect(summary.byDay[0].inputTokens).toBe(1100);
  });

  it("金额 = 未命中输入×输入价 + 命中输入×命中价 + 输出×输出价", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("token_usage", { input_tokens: 1_000_000, output_tokens: 100_000, cache_hit_tokens: 600_000, provider: "p", scene: "teach" }, "thread_a");

    const summary = summarizeCost(repository, defaultMonthlyBudgetUsd, undefined, pricing);
    expect(summary.costComponents).toEqual([
      { label: "未命中输入", tokens: 400_000, ratePerMillionUsd: 0.3, rateFallback: false, estimatedCostUsd: 0.12 },
      { label: "命中输入（缓存）", tokens: 600_000, ratePerMillionUsd: 0.03, rateFallback: false, estimatedCostUsd: 0.018 },
      { label: "输出", tokens: 100_000, ratePerMillionUsd: 0.6, rateFallback: false, estimatedCostUsd: 0.06 }
    ]);
    expect(summary.estimatedCostUsd).toBeCloseTo(0.198, 10);
    expect(summary.pricingConfigured).toBe(true);
    expect(summary.mode).toBe("normal");
  });

  it("命中价没单独配置时按输入价计，并把「没打折」这件事标出来", () => {
    const components = priceComponents({ inputTokens: 1_000_000, cacheHitTokens: 400_000, outputTokens: 0 }, { inputPerMillionUsd: 0.3, outputPerMillionUsd: 0.6 });
    const hit = components.find((component) => component.label === "命中输入（缓存）");
    expect(hit).toMatchObject({ tokens: 400_000, ratePerMillionUsd: 0.3, rateFallback: true, estimatedCostUsd: 0.12 });
  });

  it("命中数报到输入之外也夹得住，输入不会变成负数", () => {
    const components = priceComponents({ inputTokens: 100, cacheHitTokens: 500, outputTokens: 10 }, pricing);
    expect(components[0]).toMatchObject({ label: "未命中输入", tokens: 0 });
    expect(components[1]).toMatchObject({ label: "命中输入（缓存）", tokens: 100 });
  });

  it("三档单价都没配 → 金额为 0，但 pricingConfigured 说成真话", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("token_usage", { input_tokens: 5_000_000, output_tokens: 100, provider: "p", scene: "teach" }, "thread_a");
    const summary = summarizeCost(repository, defaultMonthlyBudgetUsd, undefined, { inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
    expect(summary.pricingConfigured).toBe(false);
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.inputTokens).toBe(5_000_000);
    expect(summary.mode).toBe("normal");
  });

  it("带 sessionId 时只算那条线程：回合成本读数与全月读数分开", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("token_usage", { input_tokens: 10, output_tokens: 5, provider: "p", scene: "teach" }, "thread_a");
    journal.append("token_usage", { input_tokens: 1000, output_tokens: 500, provider: "p", scene: "teach" }, "thread_b");

    const scoped = summarizeCost(repository, defaultMonthlyBudgetUsd, "thread_a", pricing);
    expect(scoped.turns).toBe(1);
    expect(scoped.inputTokens).toBe(10);
    expect(scoped.byDay).toHaveLength(1);
  });
});

/** 单价全没配时的闸门告警；配上任一档即不再告警。 */
describe("budgetGateNotice", () => {
  it("三档全没配 → 说清算不出花费、额度上限不会触发", () => {
    const notice = budgetGateNotice({ inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
    expect(notice).toContain("额度上限不会触发");
    expect(notice).toContain("配上任一单价即恢复");
  });

  it("只配了输出价也算闸门在管事 → 不再告警", () => {
    expect(budgetGateNotice({ inputPerMillionUsd: 0, outputPerMillionUsd: 1.1 })).toBeUndefined();
  });
});

/** 单价按当下配置现读，不按模块加载时算一次的值。 */
describe("currentPricing（现读两层回落）", () => {
  const RATE_ENV = ["TUTOR_INPUT_USD_PER_MILLION", "TUTOR_OUTPUT_USD_PER_MILLION", "TUTOR_CACHE_HIT_USD_PER_MILLION"];
  let pricingDir = "";

  beforeEach(() => {
    // llm-settings.json 指到临时目录，不写用户那份 ~/.codebase-tutor/。
    pricingDir = mkdtempSync(join(tmpdir(), "tutor-pricing-"));
    process.env.TUTOR_LLM_SETTINGS_FILE = join(pricingDir, "llm-settings.json");
    setLlmRuntimeSettings({ inputUsdPerMillion: "", outputUsdPerMillion: "", cacheHitUsdPerMillion: "" });
    for (const key of RATE_ENV) delete process.env[key];
  });

  afterEach(() => {
    // 顺序不能换：先清内存态（它会落盘），再撤 TUTOR_LLM_SETTINGS_FILE。
    setLlmRuntimeSettings({ inputUsdPerMillion: "", outputUsdPerMillion: "", cacheHitUsdPerMillion: "" });
    for (const key of RATE_ENV) delete process.env[key];
    delete process.env.TUTOR_LLM_SETTINGS_FILE;
    rmSync(pricingDir, { recursive: true, force: true });
  });

  it("界面留空用 .env 的值，界面填了就用界面的，两种都不需要重启", () => {
    process.env.TUTOR_INPUT_USD_PER_MILLION = "0.4";
    expect(currentPricing().inputPerMillionUsd).toBe(0.4);
    expect(pricingSourceOf("input")).toBe("env");
    setLlmRuntimeSettings({ inputUsdPerMillion: "0.28" });
    expect(currentPricing().inputPerMillionUsd).toBe(0.28);
    expect(pricingSourceOf("input")).toBe("runtime");
  });

  it("两层都没配 → 输入/输出记 0、命中价留空（按输入价计），来源说得出 unset", () => {
    expect(currentPricing()).toEqual({ inputPerMillionUsd: 0, cacheHitPerMillionUsd: undefined, outputPerMillionUsd: 0 });
    expect(pricingIsConfigured()).toBe(false);
    expect(pricingSourceOf("cacheHit")).toBe("unset");
  });

  it("界面上把输入价填上，闸门告警当场消失（这条以前只能改 .env 再重启引擎）", () => {
    expect(budgetGateNotice()).toContain("额度上限不会触发");
    setLlmRuntimeSettings({ inputUsdPerMillion: "0.28" });
    expect(budgetGateNotice()).toBeUndefined();
    expect(pricingIsConfigured()).toBe(true);
  });

  it("命中价留空时按输入价计：宁可高估也不把真花掉的钱说少", () => {
    setLlmRuntimeSettings({ inputUsdPerMillion: "0.28" });
    const rows = priceComponents({ inputTokens: 1_000_000, outputTokens: 0, cacheHitTokens: 500_000 }, currentPricing());
    // 未命中 50 万 + 命中 50 万都按输入价 0.28 计 ⇒ 合计 0.28，且命中那一行带着「按输入价计」的回落标记
    expect(rows.reduce((total, one) => total + one.estimatedCostUsd, 0)).toBeCloseTo(0.28, 6);
    expect(rows.find((one) => one.label === "命中输入（缓存）")?.rateFallback).toBe(true);
  });
});
