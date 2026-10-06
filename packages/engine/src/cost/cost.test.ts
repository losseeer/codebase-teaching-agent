import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "../store/journal.js";
import { budgetGateNotice, defaultMonthlyBudgetUsd, priceComponents, summarizeCost, type Pricing } from "./cost.js";

/**
  成本读数全部来自本月 `token_usage` 事件的分桶聚合，金额是三档单价之和。
  测试一律显式传 pricing：不依赖机器上的环境变量，算式才对得上。
  */

const pricing: Pricing = { inputPerMillionUsd: 0.3, cacheHitPerMillionUsd: 0.03, outputPerMillionUsd: 0.6 };

describe("summarizeCost", () => {
  let repository: string;

  beforeEach(() => { repository = mkdtempSync(join(tmpdir(), "tutor-cost-")); });
  afterEach(() => { rmSync(repository, { recursive: true, force: true }); });

  it("按场景与 provider 分桶，回合数、缓存命中与降级回合各算各的", () => {
    const journal = new Journal(repository, "repo_1");
    journal.append("token_usage", { input_tokens: 900, output_tokens: 100, cache_hit_tokens: 400, provider: "deepseek-chat", scene: "teach" }, "thread_a");
    journal.append("token_usage", { input_tokens: 200, output_tokens: 50, cache_hit_tokens: 0, provider: "kimi-k2", scene: "map_chat" }, "thread_b");
    // 预算触顶那一回合不付 token：provider 记本地规则、mode 记 degraded
    journal.append("token_usage", { input_tokens: 0, output_tokens: 0, cache_hit_tokens: 0, provider: "local-heuristic-v1", scene: "teach", mode: "degraded", cause: "monthly_budget_reached" }, "thread_a");

    const summary = summarizeCost(repository, defaultMonthlyBudgetUsd, undefined, pricing);
    expect(summary.turns).toBe(3);
    expect(summary.inputTokens).toBe(1100);
    expect(summary.cacheHitTokens).toBe(400);
    expect(summary.billedInputTokens).toBe(700);
    expect(summary.outputTokens).toBe(150);
    expect(summary.degradedTurns).toBe(1);
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

/**
  闸门告警：`mode` 由「算出的钱 ≥ 预算」决定，单价全零时钱恒为 0，
  于是「超预算回落本地规则」的每一条分支都静默放行。这句告警是那一整族失效唯一的出口，
  所以它的触发条件本身要有测试：配了任一档就该闭嘴，全没配才说话。
  */
describe("budgetGateNotice", () => {
  it("三档全没配 → 说清闸门未生效与花钱无上限", () => {
    const notice = budgetGateNotice({ inputPerMillionUsd: 0, outputPerMillionUsd: 0 });
    expect(notice).toContain("未生效");
    expect(notice).toContain("无上限");
  });

  it("只配了输出价也算闸门在管事 → 不再告警", () => {
    expect(budgetGateNotice({ inputPerMillionUsd: 0, outputPerMillionUsd: 1.1 })).toBeUndefined();
  });
});
