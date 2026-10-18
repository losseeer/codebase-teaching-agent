import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LlmCallRecord } from "../llm/call-log.js";
import { currentPricing, priceComponents, pricingIsConfigured, pricingSourceOf } from "../cost/cost.js";

/**
  第三阶段刀 0：把 `~/.codebase-tutor/llm.log` 按场景切成「耗时 / 失败 / token / 钱」的对照表（零 token、纯只读）。
  先测再调：`TUTOR_LLM_TIMEOUT_MS=12000` 这个数到底在哪些场景撞、撞掉多少钱、调大之后的代价是什么，
  有读数才谈得上按任务分配预算（用户 2026-10-15 那句「不要简单地把所有请求的超时统一改成更长」）。

  三条口径纪律：
  - 对账只认 `llm.log`（journal 的 teach 行在 10-08 之前含按字数造的估算 token，§37.9）；
  - 缺字段一律「未记」，不用默认值兜底——「没记」伪装成 0 会把口径问题读成产品结论；
  - **本地兜底与预算降级根本不发请求**（§43 那条 `sendsCodeToEndpoint` 表态），所以「降级频率」这个字段
    在本表里天生读不到，只能看 journal 的 `exercise_declined` / `scope_degraded`（`pnpm phase0:metrics` 出那两栏）。
*/

interface SceneRow {
  scene: string;
  tier: string;
  models: Set<string>;
  calls: number;
  ok: number;
  failed: number;
  timedOut: number;
  /** 失败原因归类（错误首行截 48 字）：调超时之前要先知道败的是哪一类 */
  errors: Map<string, number>;
  ms: number[];
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  /** 有 token 读数的行数——缺行的场景不能按 0 算钱，要按「未记」报 */
  billed: number;
  costUsd: number;
  /** 出网载荷字符数合计（含系统提示与工具清单）：用来估「调大超时会不会让一次失败更贵」。 */
  outboundChars: number;
  longestOkMs: number;
  /** 带 `attempts` 的行数（这个字段 2026-10-15 才有）：分母不齐时不能把「没记」当「一次就成」 */
  withAttempts: number;
  retried: number;
  attemptsSum: number;
}

function percentile(values: number[], q: number): string {
  if (!values.length) return "—";
  const sorted = [...values].sort((a, b) => a - b);
  return String(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
}

const money = (usd: number): string => `¥${usd.toFixed(4)}`;
const firstLine = (error: string): string => error.trim().split("\n")[0]?.slice(0, 48) ?? "（空错误）";

const file = process.env.TUTOR_LLM_LOG && process.env.TUTOR_LLM_LOG !== "off" ? process.env.TUTOR_LLM_LOG : join(homedir(), ".codebase-tutor", "llm.log");

if (!existsSync(file)) {
  console.log(`# 调用层耗时与费用画像（刀 0）\n\n数据源缺失：${file} 不存在——本表全部指标输出「未执行 + 原因」，不给你空数字。`);
  process.exit(0);
}

const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line) as LlmCallRecord]; } catch { return []; }
});
const unparsed = readFileSync(file, "utf8").split("\n").filter(Boolean).length - rows.length;

const pricing = currentPricing();
const byScene = new Map<string, SceneRow>();
const seen = new Set<string>();
let duplicates = 0;
let withTrace = 0;
const span = { first: "", last: "" };

for (const row of rows) {
  const key = `${row.scene}·${row.tier}`;
  const bucket = byScene.get(key) ?? { scene: row.scene, tier: row.tier, models: new Set<string>(), calls: 0, ok: 0, failed: 0, timedOut: 0, errors: new Map<string, number>(), ms: [], inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, billed: 0, costUsd: 0, outboundChars: 0, longestOkMs: 0, withAttempts: 0, retried: 0, attemptsSum: 0 };
  bucket.calls += 1;
  bucket.models.add(row.model);
  bucket.ms.push(row.ms);
  bucket.outboundChars += row.outbound?.chars ?? 0;
  if (typeof row.attempts === "number") {
    bucket.withAttempts += 1;
    bucket.attemptsSum += row.attempts;
    if (row.attempts > 1) bucket.retried += 1;
  }
  if (row.ok) {
    bucket.ok += 1;
    bucket.longestOkMs = Math.max(bucket.longestOkMs, row.ms);
  } else {
    bucket.failed += 1;
    const reason = row.error ?? "（没写原因）";
    if (reason.includes("请求超时")) bucket.timedOut += 1;
    bucket.errors.set(firstLine(reason), (bucket.errors.get(firstLine(reason)) ?? 0) + 1);
  }
  if (typeof row.inputTokens === "number" || typeof row.outputTokens === "number") {
    bucket.billed += 1;
    const usage = { inputTokens: row.inputTokens ?? 0, cacheHitTokens: row.cacheHitTokens ?? 0, outputTokens: row.outputTokens ?? 0 };
    bucket.inputTokens += usage.inputTokens;
    bucket.outputTokens += usage.outputTokens;
    bucket.cacheHitTokens += usage.cacheHitTokens;
    bucket.costUsd += priceComponents(usage, pricing).reduce((sum, component) => sum + component.estimatedCostUsd, 0);
  }
  if (row.traceId) {
    withTrace += 1;
    const fingerprint = `${row.traceId}|${row.scene}|${row.outbound?.hash ?? ""}`;
    if (seen.has(fingerprint)) duplicates += 1; else seen.add(fingerprint);
  }
  byScene.set(key, bucket);
  if (!span.first) span.first = row.at;
  span.last = row.at;
}

const out: string[] = [];
const emit = (line = ""): void => { out.push(line); };

emit("# 调用层耗时与费用画像（第三阶段刀 0 · 零 token · 只读）");
emit();
emit(`数据源：${file}｜行数 ${rows.length}${unparsed ? `（另有 ${unparsed} 行解析失败，已跳过）` : ""}｜时间跨度 ${span.first} → ${span.last}`);
emit(`单价口径（**本进程视角**，取数函数与成本页同一个）：输入 ${pricing.inputPerMillionUsd}（来源 ${pricingSourceOf("input")}）· 输出 ${pricing.outputPerMillionUsd}（${pricingSourceOf("output")}）· 命中 ${pricing.cacheHitPerMillionUsd ?? "未配，按输入价算"}（${pricingSourceOf("cacheHit")}）。`);
if (!pricingIsConfigured(pricing)) emit("⚠️ **本进程读不到任何单价**（三档来源都 unset）⇒ 下面「钱」一栏恒 ¥0.0000。");
if (!pricingIsConfigured(pricing)) emit("   这是【这个 shell 算不出】，不是产品没配、更不是没花钱：单价走三层回落（界面运行时 → .env → 未配），脚本只看得见自己那份环境。");
if (!pricingIsConfigured(pricing)) emit("   要和产品对账：跑之前先 set -a; source .env; set +a，或直接问在跑的引擎 GET /api/llm/settings 的 pricing 与 pricingSources。");
emit();
emit(`| 场景（档位） | 次数 | 成功 | 超时 | 其它失败 | 耗时 p50 / p90 / p95 / max（ms） | 成功里最长（ms） | 重试行/带读数行 · 平均次数 | 输入 / 输出 / 命中 token | 估算钱 | 无 token 行数 |`);
emit(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
for (const bucket of [...byScene.values()].sort((a, b) => b.calls - a.calls)) {
  const other = bucket.failed - bucket.timedOut;
  // 分母只算「带 attempts 读数的行」：10-15 之前的历史行没这个字段，把缺的当 1 会把重试率读成 0
  const attempts = bucket.withAttempts ? `${bucket.retried}/${bucket.withAttempts} · ${(bucket.attemptsSum / bucket.withAttempts).toFixed(2)}` : "这个字段没记";
  emit(`| ${bucket.scene}（${bucket.tier}） | ${bucket.calls} | ${bucket.ok} | ${bucket.timedOut} | ${other} | ${percentile(bucket.ms, 0.5)} / ${percentile(bucket.ms, 0.9)} / ${percentile(bucket.ms, 0.95)} / ${percentile(bucket.ms, 1)} | ${bucket.longestOkMs || "—"} | ${attempts} | ${bucket.inputTokens} / ${bucket.outputTokens} / ${bucket.cacheHitTokens} | ${money(bucket.costUsd)} | ${bucket.calls - bucket.billed} |`);
}
emit();

const errors = new Map<string, number>();
for (const bucket of byScene.values()) for (const [reason, count] of bucket.errors) errors.set(reason, (errors.get(reason) ?? 0) + count);
emit(`## 失败原因原样归类（动超时之前先看清败的是哪一类）`);
emit();
if (!errors.size) emit(`（一行失败都没有——那这一轮没有可归因的败例。）`);
for (const [reason, count] of [...errors.entries()].sort((a, b) => b[1] - a[1])) emit(`- ${count} 次 · ${reason}`);
emit();

emit(`## 这张表读不到的三件事（说清为什么，别用猜的数填满）`);
emit();
emit(`1. **首次与重试次数（今天起读得到，历史行读不到）**：日志包装在重试层**外面**（\`runtime.ts\` 的装配是 ThinkingOverride → Logging → Retry → 真 provider），`);
emit(`   一次逻辑调用只落一行，\`ms\` 是「含全部重试的总墙钟」。2026-10-15 起 \`RetryLlmProvider\` 把 \`attempts\` 与 \`attemptMs\` 挂在结果/错误上带出来，`);
emit(`   所以新行才有这两个节点；表里 \`重试行/带读数行\` 那列的分母就是「真带读数的行数」，缺的行按「没记」算而不按 1 算。`);
emit(`2. **降级频率**：本地兜底与预算降级按设计**不发请求**（§43），日志里根本没有这个字段。`);
emit(`   要看降级走 journal：\`exercise_declined\`（九档拒题原因，含预算已达上限）与 \`scope_degraded\`，`);
emit(`   \`pnpm phase0:metrics\` 已经把这两栏按场景聚合。`);
emit(`3. **按仓归属的钱**：导入与监听刷新那批调用没有 traceId（带 trace 的 ${withTrace}/${rows.length} 行），`);
emit(`   那部分 provider/model/token 归不到某个仓——与出网报表同一条读数口径（§48）。`);
emit();
emit(`## 顺带给的两条准备读数`);
emit();
emit(`- 同一 traceId + 同一场景 + 同一出网指纹**重复出现**的行：${duplicates} 条。这就是「同样的载荷原样重发」的下界——`);
emit(`  重试层重发的是同一份输入，所以它会留下同样的指纹（上界要等 \`attempts\` 那个字段补上才说得准）。`);
emit(`- 出网载荷合计 ${[...byScene.values()].reduce((sum, bucket) => sum + bucket.outboundChars, 0).toLocaleString()} 字符（含系统提示与工具清单），按场景分的平均字符可用来估「调大超时会不会让一次失败更贵」。`);

console.log(out.join("\n"));
