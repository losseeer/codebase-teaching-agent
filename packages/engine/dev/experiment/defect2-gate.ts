/**
  [DEV ONLY] defect2-tool-budget-2026-11 的纯计算部分：按臂汇总、冒烟 gate、全量判据。
  单独成文件，便于离线单测覆盖 gate 而不触发实验启动。
*/
export type Arm = "baseline" | "required";
export type TokenValue = number | "缺失";

export interface Row {
  arm: Arm;
  taskId: string;
  success: boolean;
  duration_ms: number;
  input_tokens: TokenValue;
  output_tokens: TokenValue;
  failure_stage?: string;
  error?: string;
  oversized_tool_rounds: number;
  tool_round_output_tokens: number;
  quality: { passed: boolean };
}

export interface GateConfig {
  minRowsPerArm: number;
  maxSuccessDeficit: number;
  maxMedianDurationRatio: number;
  requireOversizedNotWorse: boolean;
  systemErrorAborts: string[];
}

export interface Criteria {
  medianDurationDropAtLeast: number;
  successRateDropAtMostPp: number;
  tokenIncreaseAtMost: number;
  oversizedToolRoundMustDrop: boolean;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))]!;
}

/** 按臂汇总。token 缺失按《实验设计》2.2 单独计数，不按 0 处理。 */
export function summarizeArm(rows: Row[], arm: Arm): Record<string, unknown> {
  const subset = rows.filter((row) => row.arm === arm);
  const ok = subset.filter((row) => row.success);
  const usable = subset.filter((row) => typeof row.input_tokens === "number" && typeof row.output_tokens === "number");
  const okUsable = ok.filter((row) => typeof row.input_tokens === "number" && typeof row.output_tokens === "number");
  const sumTokens = (list: Row[], key: "input_tokens" | "output_tokens"): number => list.reduce((acc, row) => acc + (row[key] as number), 0);
  const input = sumTokens(usable, "input_tokens");
  const output = sumTokens(usable, "output_tokens");
  const durations = subset.map((row) => row.duration_ms);
  const okDurations = ok.map((row) => row.duration_ms);
  return {
    arm, attempts: subset.length, success: ok.length,
    success_rate: subset.length ? ok.length / subset.length : 0,
    duration_p50_ms: median(durations), duration_p95_ms: percentile95(durations),
    duration_max_ms: durations.length ? Math.max(...durations) : 0,
    success_duration_p50_ms: median(okDurations),
    input_tokens: input, output_tokens: output,
    token_missing: subset.length - usable.length, token_usable_successes: okUsable.length,
    tokens_per_success: okUsable.length ? (sumTokens(okUsable, "input_tokens") + sumTokens(okUsable, "output_tokens")) / okUsable.length : 0,
    oversized_tool_rounds: subset.reduce((acc, row) => acc + row.oversized_tool_rounds, 0),
    tool_round_output_tokens: subset.reduce((acc, row) => acc + row.tool_round_output_tokens, 0),
    quality_passed: ok.filter((row) => row.quality.passed).length,
    sample_note: subset.length < 50 ? "样本不足（<50）：p95 仅作参考" : "样本充足"
  };
}

/** 冒烟 gate：只作方向性止损，n=3 不作结论。 */
export function evaluateGate(rows: Row[], gate: GateConfig): { pass: boolean; reasons: string[]; detail: Record<string, unknown> } {
  const baseline = rows.filter((row) => row.arm === "baseline");
  const required = rows.filter((row) => row.arm === "required");
  const reasons: string[] = [];
  if (baseline.length < gate.minRowsPerArm || required.length < gate.minRowsPerArm) reasons.push(`样本不足：${baseline.length}/${required.length} < ${gate.minRowsPerArm}`);
  for (const row of rows) {
    const text = `${row.failure_stage ?? ""} ${row.error ?? ""}`;
    if (gate.systemErrorAborts.some((key) => text.includes(key))) { reasons.push(`系统级错误：${row.taskId} / ${row.arm} / ${row.failure_stage}`); break; }
  }
  const bOk = baseline.filter((row) => row.success).length;
  const rOk = required.filter((row) => row.success).length;
  if (rOk < bOk - gate.maxSuccessDeficit) reasons.push(`成功率落后 ${bOk - rOk} 题（允许 ${gate.maxSuccessDeficit}）`);
  const bMed = median(baseline.map((row) => row.duration_ms));
  const rMed = median(required.map((row) => row.duration_ms));
  if (bMed > 0 && rMed > bMed * gate.maxMedianDurationRatio) reasons.push(`耗时中位数比 ${(rMed / bMed).toFixed(2)} > ${gate.maxMedianDurationRatio}`);
  const bOver = baseline.reduce((acc, row) => acc + row.oversized_tool_rounds, 0);
  const rOver = required.reduce((acc, row) => acc + row.oversized_tool_rounds, 0);
  if (gate.requireOversizedNotWorse && rOver > bOver) reasons.push(`超长工具轮 ${rOver} > ${bOver}`);
  return {
    pass: reasons.length === 0, reasons,
    detail: { baselineSuccess: bOk, requiredSuccess: rOk, baselineMedianMs: bMed, requiredMedianMs: rMed, medianRatio: bMed > 0 ? rMed / bMed : 0, baselineOversized: bOver, requiredOversized: rOver }
  };
}

/** 全量判据。 */
export function verdictOf(summary: Record<string, Record<string, unknown>>, criteria: Criteria): Record<string, unknown> {
  const a = summary.baseline!;
  const b = summary.required!;
  const aMed = Number(a.success_duration_p50_ms) || Number(a.duration_p50_ms);
  const bMed = Number(b.success_duration_p50_ms) || Number(b.duration_p50_ms);
  const medianDrop = aMed > 0 ? 1 - bMed / aMed : 0;
  const successDropPp = (Number(a.success_rate) - Number(b.success_rate)) * 100;
  const tokensAvailable = Number(a.token_usable_successes) > 0 && Number(b.token_usable_successes) > 0;
  const tokenIncrease = tokensAvailable && Number(a.tokens_per_success) > 0 ? Number(b.tokens_per_success) / Number(a.tokens_per_success) - 1 : 0;
  const oversizedDrop = Number(a.oversized_tool_rounds) - Number(b.oversized_tool_rounds);
  const durationPass = medianDrop >= criteria.medianDurationDropAtLeast;
  const successPass = successDropPp <= criteria.successRateDropAtMostPp;
  const tokenPass = tokensAvailable && tokenIncrease <= criteria.tokenIncreaseAtMost;
  const oversizedPass = !criteria.oversizedToolRoundMustDrop || oversizedDrop > 0 || (Number(a.oversized_tool_rounds) === 0 && Number(b.oversized_tool_rounds) === 0);
  return {
    median_duration_drop: medianDrop, median_drop_required: criteria.medianDurationDropAtLeast, duration_pass: durationPass,
    success_drop_pp: successDropPp, success_drop_allowed_pp: criteria.successRateDropAtMostPp, success_pass: successPass,
    token_increase: tokenIncrease, token_increase_allowed: criteria.tokenIncreaseAtMost, tokens_available: tokensAvailable, token_pass: tokenPass,
    oversized_tool_round_drop: oversizedDrop, oversized_pass: oversizedPass,
    ...(!tokensAvailable ? { note: "token 数据缺失，成本判据不可判定" } : {}),
    all_pass: durationPass && successPass && tokenPass && oversizedPass
  };
}
