/** [DEV ONLY] 缺陷 2 消融的纯计算回归：汇总、冒烟 gate、全量判据。 */
import { describe, expect, it } from "vitest";
import { evaluateGate, summarizeArm, verdictOf, type Arm, type Criteria, type GateConfig, type Row } from "./defect2-gate.js";

const gate: GateConfig = {
  minRowsPerArm: 3, maxSuccessDeficit: 1, maxMedianDurationRatio: 1.1,
  requireOversizedNotWorse: true, systemErrorAborts: ["sandbox_unavailable", "request_error", "no_provider", "quota", "budget", "402"]
};
const criteria: Criteria = {
  medianDurationDropAtLeast: 0.1, successRateDropAtMostPp: 5,
  tokenIncreaseAtMost: 0.3, oversizedToolRoundMustDrop: true
};

function row(arm: Arm, index: number, overrides: Partial<Row> = {}): Row {
  return {
    arm, taskId: `task-${arm}-${index}`, success: true, duration_ms: 100_000,
    input_tokens: 40_000, output_tokens: 25_000, oversized_tool_rounds: 0,
    tool_round_output_tokens: 500, quality: { passed: true }, ...overrides
  };
}
function pair(index: number, baselineMs: number, requiredMs: number, extra: Partial<Row> = {}): Row[] {
  return [row("baseline", index, { duration_ms: baselineMs }), row("required", index, { duration_ms: requiredMs, ...extra })];
}
function smoke(pairs: Row[][]): Row[] { return pairs.flat(); }

describe("evaluateGate", () => {
  it("实验臂更快且超长工具轮更少 → 通过", () => {
    const rows = smoke([
      pair(0, 400_000, 300_000),
      pair(1, 420_000, 310_000, { oversized_tool_rounds: 0 }),
      pair(2, 380_000, 290_000)
    ]);
    const before = rows.filter((r) => r.arm === "baseline").map((r) => ({ ...r, oversized_tool_rounds: 1 }));
    const after = rows.filter((r) => r.arm === "required");
    const result = evaluateGate([...before, ...after], gate);
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("样本不足直接不通过", () => {
    expect(evaluateGate(smoke([pair(0, 100_000, 90_000)]), gate).pass).toBe(false);
  });

  it("耗时中位数比超过上限 → 不通过", () => {
    const rows = smoke([pair(0, 100_000, 130_000), pair(1, 100_000, 130_000), pair(2, 100_000, 130_000)]);
    const result = evaluateGate(rows, gate);
    expect(result.pass).toBe(false);
    expect(result.reasons.join()).toMatch(/耗时中位数比/);
  });

  it("成功率落后超过允许值 → 不通过", () => {
    const rows = smoke([
      pair(0, 100_000, 90_000),
      pair(1, 100_000, 90_000, { success: false, failure_stage: "provider_error" }),
      pair(2, 100_000, 90_000, { success: false, failure_stage: "provider_error" })
    ]);
    const result = evaluateGate(rows, gate);
    expect(result.pass).toBe(false);
    expect(result.reasons.join()).toMatch(/成功率落后/);
  });

  it("超长工具轮比对照更多 → 不通过", () => {
    const rows = smoke([pair(0, 100_000, 90_000, { oversized_tool_rounds: 2 }), pair(1, 100_000, 90_000), pair(2, 100_000, 90_000)]);
    expect(evaluateGate(rows, gate).reasons.join()).toMatch(/超长工具轮/);
  });

  it("系统级错误直接不通过；已知的单次超时不误杀", () => {
    const rows = smoke([
      pair(0, 100_000, 90_000),
      pair(1, 100_000, 90_000, { success: false, failure_stage: "provider_error", error: "模型请求超时（240000ms）" }),
      pair(2, 100_000, 90_000)
    ]);
    expect(evaluateGate(rows, gate).pass, "基线已知的 240s 超时不该被 gate 当成系统故障").toBe(true);
    const broken = smoke([
      pair(0, 100_000, 90_000),
      pair(1, 100_000, 90_000, { success: false, failure_stage: "sandbox_unavailable" }),
      pair(2, 100_000, 90_000)
    ]);
    expect(evaluateGate(broken, gate).reasons.join()).toMatch(/系统级错误/);
  });
});

describe("summarizeArm", () => {
  it("token 缺失单独计数，不按 0 参与平均值", () => {
    const rows = [
      row("baseline", 0, { input_tokens: 100, output_tokens: 50, success: true }),
      row("baseline", 1, { input_tokens: "缺失", output_tokens: "缺失", success: false, failure_stage: "provider_error" })
    ];
    const s = summarizeArm(rows, "baseline");
    expect(s.token_missing).toBe(1);
    expect(s.input_tokens).toBe(100);
    expect(s.output_tokens).toBe(50);
    expect(s.tokens_per_success).toBe(150);
    expect(s.token_usable_successes).toBe(1);
  });
});

describe("verdictOf", () => {
  const good = () => ({
    baseline: { success_duration_p50_ms: 400_000, duration_p50_ms: 400_000, success_rate: 0.9, token_usable_successes: 27, tokens_per_success: 70_000, oversized_tool_rounds: 10 },
    required: { success_duration_p50_ms: 340_000, duration_p50_ms: 340_000, success_rate: 0.9, token_usable_successes: 27, tokens_per_success: 70_000, oversized_tool_rounds: 2 }
  });

  it("三条判据都过 → all_pass", () => {
    const v = verdictOf(good(), criteria);
    expect(v.duration_pass).toBe(true);
    expect(v.success_pass).toBe(true);
    expect(v.token_pass).toBe(true);
    expect(v.oversized_pass).toBe(true);
    expect(v.all_pass).toBe(true);
  });

  it("耗时没降够 → 不通过", () => {
    const s = good();
    s.required.success_duration_p50_ms = 390_000;
    expect(verdictOf(s, criteria).all_pass).toBe(false);
  });

  it("token 数据缺失 → 成本判据不可判定，不把 0 增长当通过", () => {
    const s = good();
    s.required.token_usable_successes = 0;
    const v = verdictOf(s, criteria);
    expect(v.tokens_available).toBe(false);
    expect(v.token_pass).toBe(false);
    expect(v.all_pass).toBe(false);
  });
});
