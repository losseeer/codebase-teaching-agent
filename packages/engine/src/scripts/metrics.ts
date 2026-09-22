import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CourseTree, JournalEvent, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { readJournal } from "../store/journal.js";

/**
  第 1 档 · 在线聚合脚本（设计方案 §10 测量方案第 1 档）：零 LLM、纯只读，
  产出 §指标集 里「可算」项与本轮新增验收读数的基线报告（markdown 到 stdout）。

  口径纪律（§10 明文）：
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

emit(`# 指标基线报告（第 1 档 · 零 LLM 聚合）`);
emit(`生成时间：${new Date().toISOString()}｜引擎探针：${engineUrl}`);
emit(`仓库：${registry.join("、") || "（repositories.json 为空）"}`);
emit();

// ---------- 1. 仓库理解质量（需引擎在线；数据只在内存 + HTTP 输出，离线则「未执行」） ----------
emit("## 1. 仓库理解质量");
const perRepo: { path: string; id: string | null; journal: JournalEvent[] }[] = registry.map((path) => {
  const journal = readJournal(path);
  return { path, id: journal.find((event) => event.repositoryId)?.repositoryId ?? null, journal };
});
for (const repo of perRepo) {
  const label = `\`${repo.path}\`${repo.id ? `（${repo.id}）` : ""}`;
  if (!repo.id) { emit(`- ${label}：journal 无 repositoryId，未执行`); continue; }
  const analysis = await getJson<RepositoryAnalysis>(`/api/repositories/${repo.id}/analysis`);
  if (!analysis) { emit(`- ${label}：**未执行**（引擎不可达或未加载该仓库；锚点质量只在 /analysis 输出中）`); continue; }
  const index = await getJson<RepositoryIndex>(`/api/repositories/${repo.id}/index`);
  const course = await getJson<CourseTree>(`/api/repositories/${repo.id}/course`);
  for (const kind of ["micro", "macro"] as const) {
    const checks = analysis.quality?.[kind] ?? [];
    if (!checks.length) { emit(`- ${label} ${kind} 锚点有效率：未执行（该仓库此层级无断言，读「未执行」而非 0）`); continue; }
    const verified = checks.filter((check) => check.status === "verified").length;
    const skipped = checks.filter((check) => check.status === "skipped").length;
    emit(`- ${label} 锚点有效率（${kind}）：${pct(verified, checks.length - skipped)}；skipped 单列 ${skipped} 条不进分母`);
  }
  if (index) {
    const covered = new Set<string>();
    for (const implementation of analysis.implementations) covered.add(implementation.symbol.path);
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

// ---------- 2. 成本与效率 ----------
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
const http = engineRows.filter((row) => row.kind === "http" && typeof row.durationMs === "number");
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
const kinds = new Map<string, number>();
for (const row of engineRows) kinds.set(row.kind ?? "（无 kind）", (kinds.get(row.kind ?? "（无 kind）") ?? 0) + 1);
emit();
emit(`- 引擎日志事件型分布：${[...kinds].map(([kind, count]) => `${kind}=${count}`).join("、")}`);

// ---------- 4. 产品账本与行为读数（journal + tutor.db） ----------
emit();
emit("## 4. 产品账本与验收读数（journal + tutor.db，只读）");
for (const repo of perRepo) {
  emit();
  emit(`### ${repo.path}`);
  const events = repo.journal;
  if (!events.length) { emit("- journal.jsonl 为空：本日所有读数「未执行」"); continue; }
  const of = (type: string): JournalEvent[] => events.filter((event) => event.type === type);

  // 产品账本（与 §2 调用层并列，不混算）
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

  // search → read 漏斗：同 session 内 file_read 的路径是否被此前 code_search 的 top_paths 指到过
  const reads = of("file_read");
  const readOk = reads.filter((event) => event.payload.denied !== true);
  const searched = of("code_search");
  const followBySession = new Map<string, { follow: number; paths: number }>();
  for (const search of searched) {
    const top = String(search.payload.top_paths ?? "").split("、").filter(Boolean);
    const session = search.sessionId ?? "";
    const readPaths = new Set(reads.filter((event) => (event.sessionId ?? "") === session && new Date(event.at).getTime() >= new Date(search.at).getTime() && event.payload.denied !== true).map((event) => String(event.payload.path)));
    const follow = top.filter((path) => readPaths.has(path)).length;
    const bucket = followBySession.get(session) ?? { follow: 0, paths: 0 };
    followBySession.set(session, { follow: follow + bucket.follow, paths: top.length + bucket.paths });
  }
  const followTotal = [...followBySession.values()].reduce((sum, row) => sum + row.follow, 0);
  const followPaths = [...followBySession.values()].reduce((sum, row) => sum + row.paths, 0);
  emit(`- code_search：${searched.length} 次；follow-read（此后同会话读过 top 路径）：${pct(followTotal, followPaths)}${followPaths ? "" : "（无检索 → 未测）"}`);
  emit(`- file_read：${reads.length} 条（归并后），其中 denied ${pct(reads.length - readOk.length, reads.length)}`);

  // teach_moment 类型已随 companion 功能整体移除（2026-09-22），不再统计。
  emit(`- 学习语义事件完整度：${["exercise_generated", "exercise_result", "hint_depth", "action_veto", "unit_mastered", "exercise_declined"].map((type) => `${type}=${of(type).length}`).join("、")}`);

  // 练习漏斗（09-22 补口径）：送达(exercise_generated)→提交(exercise_submitted, UI 侧)→判分通过(exercise_result)；断在哪一步看拒绝的阶段分布
  {
    const generated = of("exercise_generated");
    const submitted = of("exercise_submitted");
    const results = of("exercise_result");
    const passed = results.filter((event) => event.payload.passed === true).length;
    const declined = of("exercise_declined");
    const count = (list: { payload: Record<string, unknown> }[], key: string, value: string) => list.filter((event) => String(event.payload[key]) === value).length;
    const bySource = ["llm", "cache", "rule", "review"].map((source) => `${source} ${count(generated, "source", source)}`).join("、");
    const byStage = ["no_candidates", "no_target", "llm_generate", "guard"].map((stage) => `${stage} ${count(declined, "stage", stage)}`).join("、");
    emit(`- 练习漏斗：送达 ${generated.length}（${bySource}）→ 提交 ${submitted.length} → 判分 ${results.length}（通过 ${passed}）；未送达即拒 ${declined.length}（${byStage}）`);
  }

  // 作用域降级（层 2 负向代理）：分母 = map_chat 轮次（token_usage scene 记账）；scope_paths=0 是 GUI 没上送清单，>0 是上送了但交集为空——成因不同要分列
  const degradedEvents = of("scope_degraded");
  const mapChatRounds = [...ledger].filter(([scene]) => scene === "map_chat").reduce((sum, row) => sum + row[1].calls, 0);
  const degradedNoList = degradedEvents.filter((event) => !Number(event.payload.scope_paths)).length;
  emit(`- 作用域降级（按全局视野作答）：${pct(degradedEvents.length, mapChatRounds)}；map_chat 共 ${mapChatRounds} 轮（上送清单但交集为空 ${degradedEvents.length - degradedNoList}、未上送清单 ${degradedNoList}）`);

  // 推荐入口采纳率（09-21 定口径「开文件即改选」）：分母 = 实际选型动作；按 llm 推荐与规则回落分列，混算会把降级产物当推荐质量
  const adopted = of("entry_adopted");
  const overridden = of("entry_overridden");
  const adoptedLlm = adopted.filter((event) => event.payload.source === "llm").length;
  const overriddenLlm = overridden.filter((event) => event.payload.suggested_source === "llm").length;
  emit(`- 推荐入口：采纳 ${adopted.length}（llm ${adoptedLlm}/回落 ${adopted.length - adoptedLlm}）、改选 ${overridden.length}（llm ${overriddenLlm}/回落 ${overridden.length - overriddenLlm}）；采纳率 全口径 ${pct(adopted.length, adopted.length + overridden.length)}、仅 llm 推荐 ${pct(adoptedLlm, adoptedLlm + overriddenLlm)}`);

  const dbFile = join(repo.path, ".tutor", "tutor.db");
  if (!existsSync(dbFile)) { emit("- tutor.db 缺失：flow grounding / coverageLow 未执行"); continue; }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const origins = { static: 0, inferred: 0, code: 0, 其他: 0 };
    let flows = 0;
    let truncatedDetails = 0;
    let details = 0;
    let droppedStages = 0;
    let fakePaths = 0;
    // 按需深入（map.flow.deep）的战绩只能从 flow 的 caveats 文本里挖：09-22 曾靠它定位「19 条 code 判定被驳回 18 条」
    let deepExamined = 0;
    let deepConfirmed = 0;
    let deepRejected = 0;
    let deepNoAnswer = 0;
    for (const row of db.prepare("SELECT payload FROM layer_cache WHERE cache_key LIKE 'flow:%'").all() as { payload: string }[]) {
      try {
        const parsed = JSON.parse(row.payload) as { flow?: { edges?: { origin?: string }[]; stages?: { detail?: string }[]; caveats?: string } };
        const flow = parsed.flow;
        if (!flow) continue;
        flows += 1;
        for (const edge of flow.edges ?? []) origins[edge.origin === "static" || edge.origin === "inferred" || edge.origin === "code" ? edge.origin : "其他"] += 1;
        for (const stage of flow.stages ?? []) { details += 1; if (stage.detail?.endsWith("…")) truncatedDetails += 1; }
        droppedStages += Number(flow.caveats?.match(/(\d+) 个环节因未给出存在的文件路径被丢弃/)?.[1] ?? 0);
        fakePaths += Number(flow.caveats?.match(/(\d+) 个文件路径不在仓库中/)?.[1] ?? 0);
        const caveats = flow.caveats ?? "";
        if (caveats.includes("按需深入：核对了")) {
          deepExamined += Number(caveats.match(/核对了 (\d+) 条/)?.[1] ?? 0);
          deepConfirmed += Number(caveats.match(/(\d+) 条在代码里找到依据/)?.[1] ?? 0);
          deepRejected += Number(caveats.match(/(\d+) 条因引用的文件不属于该边被驳回/)?.[1] ?? 0);
        }
        if (caveats.includes("模型没有给出结论")) deepNoAnswer += 1;
      } catch { /* 脏行跳过：聚合脚本不修数据 */ }
    }
    const edgeTotal = origins.static + origins.inferred + origins.code + origins.其他;
    emit(`- 流程 grounding（layer_cache ${flows} 条 flow 的边）：static=${origins.static}、inferred=${origins.inferred}、code=${origins.code}${origins.其他 ? `、其他=${origins.其他}` : ""}；grounding 率 ${pct(origins.static + origins.code, edgeTotal)}`);
    emit(`- 按需深入（从 flow caveats 回读，只反映「生成时未被缓存挡住」的行）：核对 ${deepExamined} 条推断边 → 升级 code ${deepConfirmed}、驳回 ${deepRejected}、模型未给结论 ${deepNoAnswer} 行`);
    emit(`- 流程 caveat 计数：丢弃环节 ${droppedStages}、编造路径 ${fakePaths}；环节 detail 触顶留痕（以…结尾）${pct(truncatedDetails, details)}`);
    const summaries = db.prepare("SELECT summary FROM summaries ORDER BY created_at DESC LIMIT 4000").all() as { summary: string }[];
    const latest = new Map<string, { coverageLow?: boolean; rule?: string }>();
    for (const row of summaries) {
      try {
        const parsed = JSON.parse(row.summary) as { path?: string; coverage?: { low?: boolean; rule?: string } };
        if (typeof parsed.path === "string" && !latest.has(parsed.path)) latest.set(parsed.path, { coverageLow: parsed.coverage?.low, rule: parsed.coverage?.rule });
      } catch { /* 旧纯文本行 = 键口径变更前产物，跳过 */ }
    }
    const low = [...latest.values()].filter((row) => row.coverageLow === true).length;
    // anchor-v2（09-22 判据换尺子）：命中缓存的行会被就地重算并打上 rule 标记；新旧混杂期间分开报
    const v2 = [...latest.values()].filter((row) => row.rule === "anchor-v2");
    const lowV2 = v2.filter((row) => row.coverageLow === true).length;
    emit(`- L1 摘要（按文件最新行）：${latest.size} 个文件，coverageLow=${low}（${pct(low, latest.size)}，09-22 起仅作读数、不再扣下游用途）；其中 anchor-v2 新判据已重算 ${v2.length} 行、判低 ${lowV2}${latest.size - v2.length ? `（其余 ${latest.size - v2.length} 行仍是旧判据结论，待下次访问就地重算）` : ""}`);
  } finally {
    db.close();
  }
}

// ---------- 5. 未测清单 ----------
emit();
emit("## 5. 本轮明确「未测」的项（口径已定、数据源未埋，逐条对应待办）");
emit("- 作用域降级：已埋 `scope_degraded`（见 §4 读数）；埋点前发生的降级无法回补，基线从本次起算；");
emit("- 推荐入口采纳/改选：已埋 `entry_adopted`/`entry_overridden`（见 §4 读数，口径=开文件即改选）；埋点前的点击无法回补；");
emit("- 每教会一个节点的平均成本：unit_mastered 样本 ≈ 0（见上面完整度行），分母不成立 → 先补事件再算；");
emit("- 表达质量归因（文件:行号 落点核验）：回合文本不落盘（教条），走离线评测档。");
emit();
console.log(out.join("\n"));
