import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CourseTree, JournalEvent, RepositoryIndex } from "@codebase-tutor/shared";
import { readJournal } from "../store/journal.js";

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

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${engineUrl}${path}`);
    return response.ok ? (await response.json() as T) : null;
  } catch {
    return null;
  }
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

emit("## 1. 仓库理解质量");
const perRepo: { path: string; id: string | null; journal: JournalEvent[] }[] = registry.map((path) => {
  const journal = readJournal(path);
  return { path, id: journal.find((event) => event.repositoryId)?.repositoryId ?? null, journal };
});
for (const repo of perRepo) {
  const label = `\`${repo.path}\`${repo.id ? `（${repo.id}）` : ""}`;
  if (!repo.id) { emit(`- ${label}：journal 无 repositoryId，未执行`); continue; }
  const index = await getJson<RepositoryIndex>(`/api/repositories/${repo.id}/index`);
  const course = await getJson<CourseTree>(`/api/repositories/${repo.id}/course`);
  if (index) {
    const covered = new Set<string>();
    if (course) {
      const walk = (node: CourseTree["root"]): void => { node.anchors.forEach((anchor) => covered.add(anchor.path)); node.children.forEach(walk); };
      walk(course.root);
    }
    const indexed = index.files.map((file) => file.path);
    const hit = indexed.filter((path) => covered.has(path)).length;
    emit(`- ${label} 解析覆盖率：${pct(hit, indexed.length)}（分母 = 索引文件数；course 树离线不可得时只含实现单元，偏低并注明）`);
  }
}
emit();

emit("## 2. 成本与效率（调用层真源 = llm.log；scene 缺失 = 未记，不兜底）");
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

  // hint_depth / action_veto / unit_mastered 已经没有生产者：下面的计数是历史存量，不是「事件掉了」
  emit(`- 学习语义事件完整度：${["exercise_generated", "exercise_result", "hint_depth", "action_veto", "unit_mastered", "exercise_declined"].map((type) => `${type}=${of(type).length}`).join("、")}`);

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

  // 作用域降级：分母 = map_chat 轮次（token_usage scene 记账）；scope_paths=0 是 GUI 没上送清单，>0 是上送了但交集为空——成因不同要分列
  const degradedEvents = of("scope_degraded");
  const mapChatRounds = [...ledger].filter(([scene]) => scene === "map_chat").reduce((sum, row) => sum + row[1].calls, 0);
  const degradedNoList = degradedEvents.filter((event) => !Number(event.payload.scope_paths)).length;
  emit(`- 作用域降级（按全局视野作答）：${pct(degradedEvents.length, mapChatRounds)}；map_chat 共 ${mapChatRounds} 轮（上送清单但交集为空 ${degradedEvents.length - degradedNoList}、未上送清单 ${degradedNoList}）`);

  // 推荐入口采纳率（口径：开文件即改选）：分母 = 实际选型动作；按 llm 推荐与规则回落分列，混算会把降级产物当推荐质量
  const adopted = of("entry_adopted");
  const overridden = of("entry_overridden");
  const adoptedLlm = adopted.filter((event) => event.payload.source === "llm").length;
  const overriddenLlm = overridden.filter((event) => event.payload.suggested_source === "llm").length;
  emit(`- 推荐入口：采纳 ${adopted.length}（llm ${adoptedLlm}/回落 ${adopted.length - adoptedLlm}）、改选 ${overridden.length}（llm ${overriddenLlm}/回落 ${overridden.length - overriddenLlm}）；采纳率 全口径 ${pct(adopted.length, adopted.length + overridden.length)}、仅 llm 推荐 ${pct(adoptedLlm, adoptedLlm + overriddenLlm)}`);

  const dbFile = join(repo.path, ".tutor", "tutor.db");
  if (!existsSync(dbFile)) { emit("- tutor.db 缺失：coverageLow 未执行"); continue; }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const summaries = db.prepare("SELECT summary FROM summaries ORDER BY created_at DESC LIMIT 4000").all() as { summary: string }[];
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
emit("- 作用域降级：已埋 `scope_degraded`（读数见第 4 节）；事件上线前的降级不在内，基线从埋点起算；");
emit("- 推荐入口采纳/改选：已埋 `entry_adopted`/`entry_overridden`（读数见第 4 节，口径=开文件即改选）；上线前的点击不在内；");
emit("- 每教会一个节点的平均成本：分母 `unit_mastered` 现在没有产出方（问答回合不再经过教学状态机）→ 这条指标没有口径；要问「一次问答多少成本」看第 2 节的 teach 场景行；");
emit("- 表达质量归因（文件:行号 落点核验）：回合文本不落盘（按设计），走离线评测档。");
emit();
console.log(out.join("\n"));
