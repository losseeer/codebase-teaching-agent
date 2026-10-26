import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JournalEvent } from "@codebase-tutor/domain";

import { readJournal } from "../../src/persistence/journal.js";
import { LATEST_SUMMARY_LIMIT } from "../../src/persistence/database.js";

/**
  在线聚合脚本（零 LLM、纯只读）：产出指标集里「可算」项与验收读数的基线报告（markdown 到 stdout）。

  口径纪律：
  - 缺字段一律落「未记」，不得用默认值兜底——「没记」伪装成 0 会把口径问题读成产品结论；
  - 数据源缺失（引擎离线、表为空）的指标输出「未执行 + 原因」，而不是空数字；
  - 锚点有效率/解析覆盖率走只读 GET（引擎在线时）；token 账单以 llm.log 为调用层真源、
    journal token_usage 为产品账本，两栏并列不混算。

  用法：pnpm phase0:metrics   （TUTOR_METRICS_ENGINE 可改引擎地址；不可达时相关项自动「未执行」）
*/

const tutorHome = join(homedir(), ".codebase-tutor");
const engineUrl = (process.env.TUTOR_METRICS_ENGINE ?? "http://localhost:3001").replace(/\/$/, "");

interface LlmLogRow {
  at?: string; scene?: string; tier?: string; ok?: boolean; ms?: number;
  inputTokens?: number; outputTokens?: number; cacheHitTokens?: number;
}

interface EngineLogRow {
  kind?: string; durationMs?: number;
  detail?: { method?: string; url?: string; status?: number };
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as T]; } catch { return []; }
  });
}

function pct(numerator: number, denominator: number): string {
  return denominator ? `${((numerator / denominator) * 100).toFixed(1)}%（${numerator}/${denominator}）` : "—";
}

function percentile(values: number[], q: number): string {
  if (!values.length) return "—";
  const sorted = [...values].sort((a, b) => a - b);
  return String(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
}

/** 同一 endpoint 的不同仓库/会话实例归一为一条曲线。 */
function normalizeUrl(url: string): string {
  return url
    .replaceAll(/repo_[0-9a-f]+/gi, ":repoId")
    .replaceAll(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, ":id");
}


const out: string[] = [];
const emit = (line = ""): void => { out.push(line); };

const registry = existsSync(join(tutorHome, "repositories.json"))
  ? ((JSON.parse(readFileSync(join(tutorHome, "repositories.json"), "utf8")).repositories ?? []) as string[])
  : [];
const llmRows = readJsonl<LlmLogRow>(join(tutorHome, "llm.log"));
const engineRows = readJsonl<EngineLogRow>(join(tutorHome, "engine.jsonl"));

emit(`# 指标基线报告（零 LLM 聚合）`);
emit(`生成时间：${new Date().toISOString()}｜引擎探针：${engineUrl}`);
emit(`仓库：${registry.join("、") || "（repositories.json 为空）"}`);
emit();

const perRepo: { path: string; id: string | null; journal: JournalEvent[] }[] = registry.map((path) => {
  const journal = readJournal(path);
  return { path, id: journal.find((event) => event.repositoryId)?.repositoryId ?? null, journal };
});

emit("## 1. 成本与效率（调用层真源 = llm.log；scene 缺失 = 未记，不兜底）");
type Bucket = { calls: number; failed: number; input: number; output: number; cacheHit: number; cacheReportedCalls: number; ms: number[] };
const buckets = new Map<string, Bucket>();
for (const row of llmRows) {
  const scene = typeof row.scene === "string" && row.scene ? row.scene : "（scene 未记）";
  const bucket = buckets.get(scene) ?? { calls: 0, failed: 0, input: 0, output: 0, cacheHit: 0, cacheReportedCalls: 0, ms: [] };
  bucket.calls += 1;
  if (row.ok === false) bucket.failed += 1;
  bucket.input += row.inputTokens ?? 0;
  bucket.output += row.outputTokens ?? 0;
  if (typeof row.cacheHitTokens === "number") { bucket.cacheHit += row.cacheHitTokens; bucket.cacheReportedCalls += 1; }
  if (typeof row.ms === "number") bucket.ms.push(row.ms);
  buckets.set(scene, bucket);
}
emit();
emit("| scene | 调用 | 失败率 | input | output | 缓存命中率(仅上报行) | p50/p95 ms |");
emit("|---|---|---|---|---|---|---|");
for (const [scene, bucket] of [...buckets].sort((a, b) => b[1].calls - a[1].calls)) {
  const cache = bucket.cacheReportedCalls
    ? `${((bucket.cacheHit / Math.max(1, bucket.input)) * 100).toFixed(1)}%（上报 ${bucket.cacheReportedCalls}/${bucket.calls} 次）`
    : "未上报";
  emit(`| ${scene} | ${bucket.calls} | ${pct(bucket.failed, bucket.calls)} | ${bucket.input.toLocaleString()} | ${bucket.output.toLocaleString()} | ${cache} | ${percentile(bucket.ms, 0.5)}/${percentile(bucket.ms, 0.95)} |`);
}
const failedTotal = llmRows.filter((row) => row.ok === false).length;
emit();
emit(`- 调用失败率（全局）：${pct(failedTotal, llmRows.length)}；llm.log 行数 ${llmRows.length}${llmRows.length ? "" : "（文件缺失 → 本节日志不存在，非零调用）"}`);

// ---------- 3. 接口延迟与引擎事件 ----------
emit();
emit("## 3. 接口延迟 p50/p95（engine.jsonl kind:http，按路由归一）");
// 历史 engine.jsonl 里仍有 /companion/ 行，过滤掉再进延迟曲线
const http = engineRows.filter((row) => row.kind === "http" && typeof row.durationMs === "number"
  && !(row.detail?.url ?? "").includes("/companion/"));
const byRoute = new Map<string, number[]>();
for (const row of http) {
  const key = `${row.detail?.method ?? "?"} ${normalizeUrl(row.detail?.url ?? "?")}`;
  byRoute.set(key, [...(byRoute.get(key) ?? []), row.durationMs as number]);
}
emit();
emit("| 路由 | 次数 | p50 | p95 |");
emit("|---|---|---|---|");
for (const [route, values] of [...byRoute].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
  emit(`| ${route} | ${values.length} | ${percentile(values, 0.5)} | ${percentile(values, 0.95)} |`);
}

emit();
emit("## 4. 产品账本与验收读数（journal + tutor.db，只读）");
for (const repo of perRepo) {
  emit();
  emit(`### ${repo.path}`);
  const events = repo.journal;
  if (!events.length) { emit("- journal.jsonl 为空：本日所有读数「未执行」"); continue; }
  const of = (type: string): JournalEvent[] => events.filter((event) => event.type === type);

  const ledger = new Map<string, { calls: number; input: number; output: number; cacheNull: number; cacheNum: number }>();
  for (const event of of("token_usage")) {
    const scene = typeof event.payload.scene === "string" && event.payload.scene ? event.payload.scene : "（scene 未记）";
    const row = ledger.get(scene) ?? { calls: 0, input: 0, output: 0, cacheNull: 0, cacheNum: 0 };
    row.calls += 1;
    row.input += Number(event.payload.input_tokens) || 0;
    row.output += Number(event.payload.output_tokens) || 0;
    if (event.payload.cache_hit_tokens === null) row.cacheNull += 1; else row.cacheNum += 1;
    ledger.set(scene, row);
  }
  emit(`- token_usage 账本：${[...ledger].map(([scene, row]) => `${scene} ${row.calls} 次 in=${row.input.toLocaleString()}/out=${row.output.toLocaleString()}（cache 未上报 ${row.cacheNull}/上报 ${row.cacheNum}）`).join("；") || "无"}`);

  const reads = of("file_read");
  const readOk = reads.filter((event) => event.payload.denied !== true);
  emit(`- code_search：${of("code_search").length} 次（原始计数）`);
  emit(`- file_read：${reads.length} 条（归并后），其中 denied ${pct(reads.length - readOk.length, reads.length)}`);

  // 落点核验早就不属于「未测」：每轮出答复前都在环复检一遍并记这条事件，这里只是把它读出来。
  const invariants = of("turn_invariant");
  const broken = invariants.filter((event) => event.payload.failed);
  emit(invariants.length
    ? `- 回合不变量复检（在环、零 token）：${invariants.length} 轮，失守 ${broken.length} 轮${broken.length ? `（${[...new Set(broken.map((event) => String(event.payload.failed)))].join("、")}）` : ""}；三作用域都判，离线机检那台架目前只喂 teach`
    : "- 回合不变量复检：未执行（journal 里没有 turn_invariant 记录——这条埋点上线前的老回合不补）");

  // 提问占比与转化率：分母是宏观设计的回合数；问出去的那些用户到底答没答，是这套机制的去留判据
  {
    const asks = of("turn_asked");
    const mapTurns = of("turn_text").filter((event) => event.payload.scene === "map_chat").length;
    const outcome = (name: string) => asks.filter((event) => event.payload.outcome === name);
    const asked = outcome("asked").length;
    const byFacet = ["goal", "range"].map((facet) => `${facet} ${outcome("asked").filter((event) => event.payload.facet === facet).length}`).join("、");
    const causes = ["expired", "new_question", "claim_missed"].map((cause) => `${cause} ${outcome("discarded").filter((event) => event.payload.reason === cause).length}`).join("、");
    emit(mapTurns
      ? `- 向用户提问占比：${pct(asked, mapTurns)}｜按格：${byFacet}｜被判据挡下 ${outcome("refused").length} 次`
      : "- 向用户提问占比：未执行（journal 里没有 map_chat 回合）");
    if (asked) emit(`- 提问之后：认领 ${outcome("claimed").length}／作废 ${outcome("discarded").length}（${causes}）｜转化率 ${pct(outcome("claimed").length, asked)}`);
  }

  // 退役那三档（hint_depth / action_veto / unit_mastered）不再计数：这里报的是「当前还在产的事件」，
  // 历史存量要单看某一条回合，走 run-trace。
  emit(`- 学习语义事件完整度：${["exercise_generated", "exercise_result", "exercise_declined"].map((type) => `${type}=${of(type).length}`).join("、")}`);

  // 练习链路：送达(exercise_generated)→提交(exercise_submitted, UI 侧)→判分通过(exercise_result)；断在哪一步看拒绝的阶段分布
  {
    const generated = of("exercise_generated");
    const submitted = of("exercise_submitted");
    const results = of("exercise_result");
    const passed = results.filter((event) => event.payload.passed === true).length;
    const declined = of("exercise_declined");
    const count = (list: { payload: Record<string, unknown> }[], key: string, value: string) => list.filter((event) => String(event.payload[key]) === value).length;
    const bySource = ["llm", "cache", "rule", "review", "code"].map((source) => `${source} ${count(generated, "source", source)}`).join("、");
    // 沙箱那两档必须单列：「模型没出成题」和「出成题但沙箱证不出这题可解」是两件事，混成一列会误导去改提示词
    const byStage = ["no_candidates", "no_target", "llm_generate", "guard", "no_provider", "provider_error", "proposal_shape", "sandbox_unavailable", "harness_validation"].map((stage) => `${stage} ${count(declined, "stage", stage)}`).join("、");
    /**
      同一档可能出自两族（`no_target` 由共用的选题路径写出），所以按族拆开列。
      旧行 payload 没有 `family` 键：单独列成「未标族别」，不悄悄算进任何一族——缺读数与读数为 0 是两件事。
      */
    const unlabelled = declined.filter((event) => typeof event.payload.family !== "string").length;
    const byFamily = ["comprehension", "code", "llm"].map((family) => `${family} ${count(declined, "family", family)}`).join("、") + `、未标族别 ${unlabelled}`;
    // 沙箱真跑了几趟（自证两趟 + 每次判分一趟）：这是「判分确实执行过代码」的证据
    const runs = of("exercise_run");
    const runOutcome = ["accepted", "passed", "failed", "no-verdict"].map((outcome) => `${outcome} ${count(runs, "outcome", outcome)}`).join("、");
    emit(`- 沙箱运行：${runs.length} 趟（自证 ${count(runs, "stage", "validate-proposal")}、判分 ${count(runs, "stage", "grade")}）；结论 ${runOutcome}；超时 ${runs.filter((event) => event.payload.timed_out === true).length}、没印 TESTS 结论 ${runs.filter((event) => event.payload.verdict_passed === null).length}`);
    emit(`- 练习链路：送达 ${generated.length}（${bySource}）→ 提交 ${submitted.length} → 判分 ${results.length}（通过 ${passed}）；未送达即拒 ${declined.length}（按族 ${byFamily}；按档 ${byStage}）`);
  }

  const dbFile = join(repo.path, ".tutor", "tutor.db");
  if (!existsSync(dbFile)) { emit("- tutor.db 缺失：coverageLow 未执行"); continue; }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const summaries = db.prepare(`SELECT summary FROM summaries ORDER BY created_at DESC LIMIT ${LATEST_SUMMARY_LIMIT}`).all() as { summary: string }[];
    const latest = new Map<string, { coverageLow?: boolean; rule?: string }>();
    for (const row of summaries) {
      try {
        const parsed = JSON.parse(row.summary) as { path?: string; coverage?: { low?: boolean; rule?: string } };
        if (typeof parsed.path === "string" && !latest.has(parsed.path)) latest.set(parsed.path, { coverageLow: parsed.coverage?.low, rule: parsed.coverage?.rule });
      } catch { /* 非 JSON 行跳过 */ }
    }
    const low = [...latest.values()].filter((row) => row.coverageLow === true).length;
    // anchor-v2：命中缓存的行会被就地重算并打上 rule 标记；两种判据混杂期间分开报
    const v2 = [...latest.values()].filter((row) => row.rule === "anchor-v2");
    const lowV2 = v2.filter((row) => row.coverageLow === true).length;
    emit(`- L1 摘要（按文件最新行）：${latest.size} 个文件，coverageLow=${low}（${pct(low, latest.size)}，仅作读数、不再扣下游用途）；其中 anchor-v2 判据已重算 ${v2.length} 行、判低 ${lowV2}${latest.size - v2.length ? `（其余 ${latest.size - v2.length} 行仍是旧判据结论，待下次访问就地重算）` : ""}`);
  } finally {
    db.close();
  }
}

emit();
emit("## 5. 明确「未测」的项（口径已定、数据源未埋，逐条对应待办）");
emit("- 每教会一个节点的平均成本：分母 `unit_mastered` 现在没有产出方（问答回合不再经过教学状态机）→ 这条指标没有口径；要问「一次问答多少成本」看第 2 节的 teach 场景行；");
emit();
console.log(out.join("\n"));
