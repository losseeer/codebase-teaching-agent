/**
  [DEV ONLY] design-followup-2026-11：设计题生成消融（付费、串行、按任务配对）。

  用法（在 engine 包内经 pnpm script 调用）：
    pnpm experiment:design-followup --dry
    pnpm experiment:design-followup --pairs=2
    pnpm experiment:design-followup --from=2
    pnpm experiment:design-followup --arm=three-stage

  两臂在同一进程、同一模型、同一冻结副本、同一份参考摘录上按任务配对；
  臂顺序按配对序号交替。对照臂直接调产品的 generateCodeExerciseFromReference
  （单次生成 + 整份修复 + 自由 JSON + 模型写测试）；实验臂自 2026-11-05 起改调
  generateTwoStage（两段：首段题面+实现走工具循环，第二段只出测试）。
  三段编排 generateThreeStage 保留为历史臂，不再默认调用。
  两臂都不落库、不写产品 journal，避免污染基线账本；度量直接取自生成结果。

  挂载口径（2026-11-05 修复）：冻结副本的 .tutor/tutor.db 是从旧目录
  `experiments/baseline/repos/` 搬来的，库中 repository_state.repository_id
  与按**当前路径**算出的 catalogRepositoryId 不同。因此这里不依赖
  importer.ensureMounted（它会用新 id 查空 state），而是按 manifest 冻结的
  artifactRepositoryId 直接构造 RepositoryHandle 并读 state。
*/
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadDotEnv } from "../../src/boot.js";
import type { ExerciseFaces } from "../../src/exercises/turn-faces.js";
import type { ImportedRepository } from "../../src/importer/importer.js";
import type { CodeGeneration } from "../../src/exercises/code-generate.js";
import { generateTwoStage, promptSectionsComplete } from "./design-two-stage.js";
import { assertFrozen, csv, mountFrozen, qualityOf, type TopicRow } from "./frozen-dataset.js";

const root = resolve(import.meta.dirname, "../../../..");
const datasetDir = resolve(root, "experiments/design-followup-2026-11");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const pairsArg = args.find((arg) => arg.startsWith("--pairs="));
const pairLimit = pairsArg ? Math.max(1, Math.floor(Number(pairsArg.split("=")[1]))) : Infinity;
const fromArg = args.find((arg) => arg.startsWith("--from="));
const pairStart = fromArg ? Math.max(0, Math.floor(Number(fromArg.split("=")[1]))) : 0;
const armFilter = args.find((arg) => arg.startsWith("--arm="))?.split("=")[1];
const outArg = args.find((arg) => arg.startsWith("--out="))?.split("=")[1];
const runId = process.env.DESIGN_FOLLOWUP_RUN_ID ?? new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
const manifest = JSON.parse(readFileSync(join(datasetDir, "manifest.json"), "utf8")) as Manifest;
const outFile = outArg ? resolve(root, outArg) : join(datasetDir, manifest.outputs.exercises);
const summaryFile = outArg ? outFile.replace(/\.jsonl$/, ".summary.json") : join(datasetDir, manifest.outputs.summary);

interface Manifest {
  experimentId: string;
  datasetId: string;
  frozenAt: string;
  sourceDataset: string;
  model: { provider: string; name: string; timeoutMs: number; promptVersion: string };
  /** artifactRepositoryId = 副本 .tutor/tutor.db 里 repository_state.repository_id 的真实值。 */
  repos: { name: string; language: string; path: string; commit: string; contentDigest: string; artifactRepositoryId: string; design: boolean }[];
  inputs: { topics: string };
  outputs: { exercises: string; summary: string };
  arms: { id: Arm; label: string }[];
  rules: { pairing: string; maxAttemptsPerTask: number; taskTimeoutMs: number };
  criteria: { p95DropAtLeast: number; successRateDropAtMostPp: number; tokenIncreaseAtMost: number };
}

type Arm = "single" | "three-stage";

interface Row {
  experimentId: string;
  datasetId: string;
  runId: string;
  at: string;
  pairIndex: number;
  armOrder: string;
  arm: Arm;
  taskId: string;
  repository: string;
  language: string;
  exercise_type: "design";
  topic: string;
  model: string;
  prompt_version: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  success: boolean;
  generation_source: string;
  failure_stage?: string;
  error?: string;
  /** 按《实验设计》2.2：模型没回 usage 时标「缺失」，不按 0 处理。 */
  input_tokens: number | "缺失";
  output_tokens: number | "缺失";
  cache_hit_tokens: number | "缺失";
  model_calls: number;
  tool_calls: number;
  sandbox_runs: number;
  title?: string;
  quality: { prompt_sections_complete: boolean; assertion_count: number; defect_targeted: boolean; passed: boolean };
}

const topics = csv(join(datasetDir, manifest.inputs.topics)) as unknown as TopicRow[];

const quantile = (values: number[], q: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]!;
};

function summaryOf(rows: Row[], arm: Arm): Record<string, unknown> {
  const subset = rows.filter((row) => row.arm === arm);
  const ok = subset.filter((row) => row.success);
  const durations = subset.map((row) => row.duration_ms);
  // 《实验设计》2.2：token 缺失单独计数，不参与平均值计算，也不按 0 处理。
  const hasTokens = (row: Row): boolean => typeof row.input_tokens === "number" && typeof row.output_tokens === "number";
  const usable = subset.filter(hasTokens);
  const okUsable = ok.filter(hasTokens);
  const sumTokens = (list: Row[], key: "input_tokens" | "output_tokens"): number =>
    list.reduce((acc, row) => acc + (row[key] as number), 0);
  const input = sumTokens(usable, "input_tokens");
  const output = sumTokens(usable, "output_tokens");
  return {
    arm, attempts: subset.length, success: ok.length,
    success_rate: subset.length ? ok.length / subset.length : 0,
    duration_p50_ms: quantile(durations, 0.5),
    duration_p95_ms: quantile(durations, 0.95),
    duration_max_ms: durations.length ? Math.max(...durations) : 0,
    input_tokens: input, output_tokens: output,
    token_missing: subset.length - usable.length,
    token_usable_attempts: usable.length,
    token_usable_successes: okUsable.length,
    tokens_per_attempt: usable.length ? (input + output) / usable.length : 0,
    tokens_per_success: okUsable.length ? (sumTokens(okUsable, "input_tokens") + sumTokens(okUsable, "output_tokens")) / okUsable.length : 0,
    quality_passed: ok.filter((row) => row.quality.passed).length,
    // 按《实验设计》5.3：单组 <50 不正式报 p95，这里只留作预登记判据的对照读数。
    sample_note: subset.length < 50 ? "样本不足（<50）：p95 仅作判据对照，不作正式报告" : "样本充足"
  };
}

function verdictOf(summary: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const a = summary.single!;
  const b = summary["three-stage"]!;
  const p95Drop = Number(a.duration_p95_ms) > 0 ? 1 - Number(b.duration_p95_ms) / Number(a.duration_p95_ms) : 0;
  const successDropPp = (Number(a.success_rate) - Number(b.success_rate)) * 100;
  // 两臂都没有可用 token 时，成本判据不可判定；不能把 0 增长当成「通过」。
  const tokensAvailable = Number(a.token_usable_successes) > 0 && Number(b.token_usable_successes) > 0;
  const tokenIncrease = tokensAvailable && Number(a.tokens_per_success) > 0 ? Number(b.tokens_per_success) / Number(a.tokens_per_success) - 1 : 0;
  const p95Pass = p95Drop >= manifest.criteria.p95DropAtLeast;
  const successPass = successDropPp <= manifest.criteria.successRateDropAtMostPp;
  const tokenPass = tokensAvailable && tokenIncrease <= manifest.criteria.tokenIncreaseAtMost;
  return {
    p95_drop: p95Drop, p95_drop_required: manifest.criteria.p95DropAtLeast, p95_pass: p95Pass,
    success_drop_pp: successDropPp, success_drop_allowed_pp: manifest.criteria.successRateDropAtMostPp, success_pass: successPass,
    token_increase: tokenIncrease, token_increase_allowed: manifest.criteria.tokenIncreaseAtMost, token_pass: tokenPass,
    tokens_available: tokensAvailable,
    ...(!tokensAvailable ? { note: "两臂缺少可用 token 数据，成本判据无法判定" } : {}),
    all_pass: p95Pass && successPass && tokenPass
  };
}

console.log(`# ${manifest.experimentId}\n`);
console.log(`- 数据集：${manifest.datasetId}（${topics.length} 个设计题任务，${manifest.repos.length} 仓）`);
console.log(`- 配对：${Math.min(pairLimit, Math.max(0, topics.length - pairStart))} 个任务 × ${armFilter ? 1 : 2} 臂；臂顺序交替`);
console.log(`- runId=${runId} 结果=${outFile}${dry ? "（dry-run，不写结果）" : ""}\n`);
try {
  assertFrozen({ root, repos: manifest.repos, topics });
} catch (error) {
  console.error(`[design-followup] 冻结校验失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (dry) {
  console.log("冻结校验通过：内容指纹与产物库身份均与清单一致。");
  console.log("提示：挂载可达性（state 三行可读）在实跑开始时再次预检，失败立即非零退出。\n");
  for (const [index, row] of topics.entries()) if (index >= pairStart && index < pairStart + pairLimit) console.log(`  · ${index} ${row.repo} / ${row.topic} (${row.tag_id})`);
  process.exit(0);
}

loadDotEnv();
// 独立地址簿与日志：隔离实验与日常使用；挂载本身不读地址簿（见 mountFrozen）。
const registryDir = mkdtempSync(join(tmpdir(), "tutor-design-followup-"));
const registryFile = join(registryDir, "repositories.json");
writeFileSync(registryFile, JSON.stringify({ repositories: manifest.repos.map((repo) => resolve(root, repo.path)) }), "utf8");
process.env.TUTOR_REGISTRY_FILE = registryFile;
process.env.TUTOR_LLM_LOG ??= join(datasetDir, "llm.log");

const { lightLlm } = await import("../../src/infrastructure/composition-root.js");
const { ensureIsolation } = await import("../../src/adapter/outbound/sandbox/isolation.js");
const { generateCodeExerciseFromReference } = await import("../../src/exercises/code-generate.js");
const { selectTagCandidates } = await import("../../src/exercises/exercises.js");
const { withExercisePorts, practiceView } = await import("../../src/infrastructure/exercise-ports.js");
const { skillsForTurn } = await import("../../src/application/orchestration/scoped-turn.js");
const { searchCorpusFor, turnBudgetGuard } = await import("../../src/application/orchestration/paid-turn.js");
const { factsToolFor } = await import("../../src/infrastructure/canvas-tools.js");
const { RepositoryHandle } = await import("../../src/adapter/outbound/persistence/repository-handle.js");

const provider = lightLlm();
if (!provider) { console.error("未执行：没有解析出模型档（未配置或预算已到线）。"); rmSync(registryDir, { recursive: true, force: true }); process.exit(2); }
const isolation = await ensureIsolation();
if (isolation.level !== "enforced") { console.error(`未执行：沙箱不可用（${isolation.reason}）。`); rmSync(registryDir, { recursive: true, force: true }); process.exit(2); }

/** 与产品 nextReferenceCode 同款：6 段候选摘录拼成 ≤24000 字参考素材。 */
async function referenceFor(repository: ImportedRepository, tag: string): Promise<string> {
  return withExercisePorts(repository.handle, (ports) => {
    const summaries = new Map(ports.summaries.latest().map((row) => [row.path, row.summary]));
    const candidates = selectTagCandidates(practiceView(repository, ports), tag, 6, summaries);
    return candidates.map((candidate) => `## ${candidate.path}\n${candidate.excerpt}`).join("\n\n").slice(0, 24_000);
  });
}

function facesFor(repository: ImportedRepository, database: ReturnType<ImportedRepository["handle"]["pin"]>, counters: { model: number; tool: number }): ExerciseFaces {
  const skills = skillsForTurn();
  return {
    scope: "practice",
    repoPath: repository.path,
    search: searchCorpusFor(repository),
    facts: factsToolFor(repository, database),
    ...(skills ? { skills } : {}),
    budgetGuard: turnBudgetGuard(repository.handle),
    onTrace: (step: { kind: string; status: string }) => {
      if (step.status !== "ok") return;
      if (step.kind === "model") counters.model += 1;
      if (step.kind === "tool") counters.tool += 1;
    }
  };
}

async function runOne(repository: ImportedRepository, row: TopicRow, arm: Arm, pairIndex: number, armOrder: string): Promise<Row> {
  const database = repository.handle.pin();
  const counters = { model: 0, tool: 0 };
  const faces = facesFor(repository, database, counters);
  const started = new Date();
  let generation: CodeGeneration;
  try {
    const reference = await referenceFor(repository, row.topic);
    const base = { repositoryPath: repository.path, tag: row.topic, kind: "patch_edit" as const, reference, provider: provider!, faces };
    generation = arm === "single"
      ? await generateCodeExerciseFromReference(base)
      : await generateTwoStage(base);
  } catch (error) {
    generation = {
      ok: false, stage: "provider_error", reason: error instanceof Error ? error.message : String(error),
      runs: [], skillReads: []
    };
  } finally {
    repository.handle.unpin();
  }
  const ended = new Date();
  const quality = qualityOf(generation);
  const out: Row = {
    experimentId: manifest.experimentId, datasetId: manifest.datasetId, runId,
    at: ended.toISOString(), pairIndex, armOrder, arm,
    taskId: `exercise:${row.repo}:design:${row.tag_id}`,
    repository: row.repo, language: manifest.repos.find((repo) => repo.name === row.repo)?.language ?? "unknown",
    exercise_type: "design", topic: row.topic,
    model: provider!.modelVersion, prompt_version: manifest.model.promptVersion,
    started_at: started.toISOString(), ended_at: ended.toISOString(), duration_ms: ended.getTime() - started.getTime(),
    success: generation.ok, generation_source: arm === "single" ? "code" : "two-stage",
    input_tokens: generation.usage?.inputTokens ?? "缺失",
    output_tokens: generation.usage?.outputTokens ?? "缺失",
    cache_hit_tokens: generation.usage?.promptCacheHitTokens ?? "缺失",
    model_calls: counters.model, tool_calls: counters.tool, sandbox_runs: generation.runs.length,
    quality,
    ...(generation.ok
      ? { title: generation.proposal.title }
      : { failure_stage: generation.stage, error: generation.reason.slice(0, 300) })
  };
  return out;
}

const arms: Arm[] = armFilter ? [armFilter as Arm] : ["single", "three-stage"];
if (armFilter && !["single", "three-stage"].includes(armFilter)) throw new Error(`未知臂 ${armFilter}`);
if (!armFilter && !fromArg && existsSync(outFile) && readFileSync(outFile, "utf8").trim()) {
  throw new Error(`结果文件已有内容：${outFile}。请用 --from=N 续跑或 --out= 另存，避免覆盖原始记录。`);
}

const expectedPairs = Math.min(pairLimit, Math.max(0, topics.length - pairStart));
const expectedRows = expectedPairs * arms.length;
const mounted = new Map<string, ImportedRepository>();
const rows: Row[] = [];
let stopped = false;
let failure: string | undefined;

try {
  // 全仓挂载预检：任何一个仓的 state 读不出来就立即停机，绝不「跳过」后空转。
  for (const repo of manifest.repos) {
    try {
      mounted.set(repo.name, await mountFrozen(repo, root));
    } catch (error) {
      throw new Error(`挂载 ${repo.name} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`- 产物挂载预检：${mounted.size}/${manifest.repos.length} 仓通过\n`);

  for (const [index, row] of topics.entries()) {
    if (index < pairStart || index >= pairStart + pairLimit) continue;
    const repository = mounted.get(row.repo);
    if (!repository) throw new Error(`${row.repo} 不在冻结清单里`);
    // 交替臂顺序：偶数配对先跑对照，奇数配对先跑实验。
    const order = index % 2 === 0 ? arms : [...arms].reverse();
    for (const arm of order) {
      const out = await runOne(repository, row, arm, index, order.join(">"));
      rows.push(out);
      appendFileSync(outFile, `${JSON.stringify(out)}\n`, "utf8");
      console.log(`${index} ${row.repo} / ${row.topic} / ${arm}：${out.success ? `成功${out.quality.passed ? "" : "（质量护栏未过）"}` : `失败（${out.failure_stage}）`}｜${(out.duration_ms / 1000).toFixed(1)}s｜in ${out.input_tokens} / out ${out.output_tokens}`);
      // 余额/预算类错误立即停机，不把剩余配对烧掉；失败不静默吞掉。
      if (!out.success && /402|余额|insufficient|quota|budget/i.test(`${out.failure_stage ?? ""} ${out.error ?? ""}`)) {
        failure = "检测到余额或预算不足，已停在当前配对；修正后用 --from=<配对序号> 续跑。";
        stopped = true;
        break;
      }
    }
    if (stopped) break;
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(`[design-followup] 执行失败：${failure}`);
} finally {
  for (const repository of mounted.values()) repository.handle.close();
  rmSync(registryDir, { recursive: true, force: true });
}

const complete = !stopped && !failure && rows.length === expectedRows;
const summary = Object.fromEntries((["single", "three-stage"] as Arm[]).map((arm) => [arm, summaryOf(rows, arm)])) as Record<string, Record<string, unknown>>;
const verdict = rows.length === 0
  ? { note: "无数据：本轮没有产生任何出题尝试" }
  : rows.some((row) => row.arm === "single") && rows.some((row) => row.arm === "three-stage")
    ? verdictOf(summary)
    : { note: "本轮只跑了一臂，不出判据结论" };
const report = {
  experimentId: manifest.experimentId, runId, at: new Date().toISOString(),
  status: complete ? "completed" : "failed",
  expectedRows, rows: rows.length, stopped,
  ...(failure ? { failure } : {}),
  summary, verdict
};
writeFileSync(summaryFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n## 汇总（status=${report.status}）\n`);
for (const arm of ["single", "three-stage"] as Arm[]) {
  const s = summary[arm]!;
  console.log(`- ${arm}：${s.success}/${s.attempts}（${(Number(s.success_rate) * 100).toFixed(1)}%）｜p50 ${(Number(s.duration_p50_ms) / 1000).toFixed(1)}s｜p95 ${(Number(s.duration_p95_ms) / 1000).toFixed(1)}s（仅判据对照）｜in ${s.input_tokens} / out ${s.output_tokens}｜token 缺失 ${s.token_missing}｜质量护栏 ${s.quality_passed}`);
}
console.log(`- 判据：${JSON.stringify(verdict)}`);
console.log(`\n结果已写入 ${outFile}；汇总见 ${summaryFile}`);
if (!complete) {
  console.error(`[design-followup] 未完成：期望 ${expectedRows} 次尝试，实际 ${rows.length} 次。${failure ?? ""}`);
  process.exitCode = 2;
}
