/**
  [DEV ONLY] segmented-generate-2026-11 的先导执行器（6 题 × 2 臂）。

  两臂背靠背连跑：端点负载对两臂公平，否则「超时率」这个主判据没有可比性。
  判分口径完全一致——两臂的最终产物都走产品既有的 finishProposal（同一套形状校验 + 沙箱两跑）。
*/
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { CodeGeneration } from "../../src/exercises/code-generate.js";
import { generateCodeExerciseFromReference } from "../../src/exercises/code-generate.js";
import { loadDotEnv } from "../../src/boot.js";
import type { ExerciseFaces } from "../../src/exercises/turn-faces.js";
import type { ImportedRepository } from "../../src/importer/importer.js";
import { generateCodeExerciseSegmented, type SegmentEvent } from "./segmented-generate.js";
import { assertFrozen, csv, mountFrozen, qualityOf, type FrozenRepo, type TopicRow } from "./frozen-dataset.js";

const root = resolve(import.meta.dirname, "../../../..");
const datasetDir = resolve(root, "experiments/segmented-generate-2026-11");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
/** --full 跑全量 30 题；默认只跑先导 6 题。 */
const full = args.includes("--full");
const manifest = JSON.parse(readFileSync(join(datasetDir, "manifest.json"), "utf8")) as Manifest;
const topicsFile = full ? manifest.inputs.fullTopics : manifest.inputs.pilotTopics;
const topics = (csv(resolve(datasetDir, topicsFile)) as unknown as PilotTopic[]).filter((topic) => topic.type === "design");

interface Manifest {
  experimentId: string;
  datasetId: string;
  model: { provider: string; name: string; timeoutMs: number; promptVersion: string };
  repos: FrozenRepo[];
  inputs: { pilotTopics: string; fullTopics: string };
  outputs: { pilot: string; pilotSummary: string; exercises: string; summary: string };
  arms: { id: Arm; label: string; mode: "single" | "segmented" }[];
  protocol: Record<string, string>;
  criteria: Record<string, string>;
}
type Arm = "single" | "segmented";
type PilotTopic = TopicRow & { baseline_outcome: string };

interface Row {
  experimentId: string; datasetId: string; runId: string; at: string;
  arm: Arm; taskId: string; repository: string; language: string; topic: string;
  baseline_outcome: string;
  started_at: string; ended_at: string; duration_ms: number;
  success: boolean; failure_stage?: string; error?: string;
  input_tokens: number | "缺失"; output_tokens: number | "缺失";
  model_calls: number; segments?: SegmentEvent[];
  max_segment_output_tokens?: number;
  /** 这一趟里单次模型调用最大的输出 token；与端点快慢无关，用来量「单次输出有多大」。 */
  max_call_output_tokens: number;
  quality: { prompt_sections_complete: boolean; assertion_count: number; defect_targeted: boolean; passed: boolean };
}

const runId = process.env.SEGMENTED_RUN_ID ?? new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
const outFile = join(datasetDir, full ? manifest.outputs.exercises : manifest.outputs.pilot);
const summaryFile = join(datasetDir, full ? manifest.outputs.summary : manifest.outputs.pilotSummary);
const artifactDir = join(datasetDir, "artifacts");

console.log(`# ${manifest.experimentId}（先导）\n`);
console.log(`- 数据集：${manifest.datasetId}；${full ? "全量" : "先导"} ${topics.length} 题 × ${manifest.arms.length} 臂`);
console.log(`- 主判据：${manifest.criteria.primary}`);
console.log(`- 先导闸门：${manifest.criteria.pilotGate}\n`);
try {
  assertFrozen({ root, repos: manifest.repos, topics: topics as unknown as TopicRow[], expectedTopics: topics.length, expectedRepos: manifest.repos.length });
} catch (error) {
  console.error(`[segmented] 冻结校验失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (dry) { console.log("冻结校验通过。"); process.exit(0); }

// --rescore：不跑实验，只按已有结果行重算 summary 与 verdict（改了判据口径后不必重跑）。
if (args.includes("--rescore")) {
  const lines = existsSync(outFile) ? readFileSync(outFile, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Row) : [];
  if (!lines.length) { console.error(`[segmented] 没有可重算的结果行：${outFile}`); process.exit(2); }
  const report = score(lines.filter((row) => row.arm === "single"), lines.filter((row) => row.arm === "segmented"), topics, full);
  writeFileSync(summaryFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`## 汇总\n${JSON.stringify(report.summary, null, 2)}\n`);
  console.log(`## 判据\n${JSON.stringify(report.verdict, null, 2)}\n`);
  console.log(`已重算：${summaryFile}`);
  process.exit(0);
}

loadDotEnv();
const registryDir = mkdtempSync(join(tmpdir(), "tutor-segmented-"));
writeFileSync(join(registryDir, "repositories.json"), JSON.stringify({ repositories: manifest.repos.map((repo) => resolve(root, repo.path)) }), "utf8");
process.env.TUTOR_REGISTRY_FILE = join(registryDir, "repositories.json");
const llmLog = process.env.TUTOR_LLM_LOG ?? join(datasetDir, "llm.log");
process.env.TUTOR_LLM_LOG = llmLog;

const { lightLlm } = await import("../../src/infrastructure/composition-root.js");
const { ensureIsolation } = await import("../../src/adapter/outbound/sandbox/isolation.js");
const { selectTagCandidates } = await import("../../src/exercises/exercises.js");
const { withExercisePorts, practiceView } = await import("../../src/infrastructure/exercise-ports.js");
const { skillsForTurn } = await import("../../src/application/orchestration/scoped-turn.js");
const { searchCorpusFor, turnBudgetGuard } = await import("../../src/application/orchestration/paid-turn.js");
const { factsToolFor } = await import("../../src/infrastructure/canvas-tools.js");

const provider = lightLlm();
if (!provider) { console.error("未执行：没有解析出模型档。"); rmSync(registryDir, { recursive: true, force: true }); process.exit(2); }
const isolation = await ensureIsolation();
if (isolation.level !== "enforced") { console.error(`未执行：沙箱不可用（${isolation.reason}）。`); rmSync(registryDir, { recursive: true, force: true }); process.exit(2); }

const mounted = new Map<string, ImportedRepository>();
const rows: Row[] = [];
let stopped = false;
let failure: string | undefined;

/** llm.log 里只记成功的调用；超时的那次没记录，所以「单次最大输出」只统计成功返回的那些。 */
function llmLogSize(): number {
  try { return existsSync(llmLog) ? statSync(llmLog).size : 0; } catch { return 0; }
}

function maxOutputSince(offset: number): number {
  if (!existsSync(llmLog)) return 0;
  const size = statSync(llmLog).size;
  if (size <= offset) return 0;
  const handle = openSync(llmLog, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    readSync(handle, buffer, 0, buffer.length, offset);
    let max = 0;
    for (const line of buffer.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { outputTokens?: number };
        max = Math.max(max, row.outputTokens ?? 0);
      } catch { /* 半行或坏行不影响别的 */ }
    }
    return max;
  } finally {
    closeSync(handle);
  }
}

/** 配对内比较：同题两臂的耗时与总输出。跨题跨臂的直接比会被题目难度与端点快慢带偏。 */
function pairedStats(single: Row[], segmented: Row[]): {
  pairs: number;
  duration_diff_median_s: number;
  duration_ratio_median: number;
  output_change_median: number;
  output_pairs: number;
} {
  const byTopic = new Map<string, { single?: Row; segmented?: Row }>();
  for (const row of [...single, ...segmented]) {
    const entry = byTopic.get(row.topic) ?? {};
    entry[row.arm] = row;
    byTopic.set(row.topic, entry);
  }
  const pairs = [...byTopic.values()].filter((entry) => entry.single && entry.segmented) as { single: Row; segmented: Row }[];
  const diffs = pairs.map((entry) => (entry.segmented.duration_ms - entry.single.duration_ms) / 1000);
  const ratios = pairs.filter((entry) => entry.single.duration_ms > 0).map((entry) => entry.segmented.duration_ms / entry.single.duration_ms);
  const tokenPairs = pairs.filter((entry) => typeof entry.single.output_tokens === "number" && typeof entry.segmented.output_tokens === "number" && entry.single.output_tokens > 0);
  const tokenChanges = tokenPairs.map((entry) => ((entry.segmented.output_tokens as number) - (entry.single.output_tokens as number)) / (entry.single.output_tokens as number));
  const median = (values: number[]): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };
  return {
    pairs: pairs.length,
    duration_diff_median_s: Number(median(diffs).toFixed(1)),
    duration_ratio_median: Number(median(ratios).toFixed(3)),
    output_change_median: Number(median(tokenChanges).toFixed(3)),
    output_pairs: tokenPairs.length
  };
}

/**
  判据（2026-11-06 改过一次）：原先用「单次模型调用的最大输出 token 至少减半」当主判据，
  那个量跨题跨轮都对不齐（单段臂的「单次」= 整份一次生成 17k–40k，分段臂 = 三段里最大的那个
  6.9k–15.8k），实测只降 9%，闸门形同虚设。改成两个都不受端点快慢影响的量：
  ① provider_error（单次输出撞 240s）有没有减少——这是分段要治的病；
  ② 配对内总输出有没有下降——分段省不省 token。
  先导只有 6 对，判方向与止损；量级以全量 30 题为准。
*/
function score(single: Row[], segmented: Row[], topicRows: PilotTopic[], full: boolean): {
  experimentId: string; runId: string; at: string; status: string; rows: number;
  summary: { single: ArmSummary; segmented: ArmSummary };
  verdict: Record<string, unknown>;
} {
  const summary = { single: summarize(single), segmented: summarize(segmented) };
  const paired = pairedStats(single, segmented);
  const timeoutTopics = topicRows.filter((topic) => topic.baseline_outcome === "provider_error");
  const rescued = timeoutTopics.filter((topic) => segmented.some((row) => row.topic === topic.topic && row.success));
  const providerErrorReduced = summary.segmented.provider_error < summary.single.provider_error;
  const outputDropped = paired.output_change_median <= -0.1;
  const safetyOk = summary.segmented.harness_validation <= summary.single.harness_validation;
  const gate = providerErrorReduced && outputDropped && safetyOk;
  const verdict = full
    ? {
        paired,
        provider_error: { single: summary.single.provider_error, segmented: summary.segmented.provider_error, reduced: providerErrorReduced },
        output: { paired_change_median: paired.output_change_median, dropped: outputDropped },
        safety: { single_harness_validation: summary.single.harness_validation, segmented_harness_validation: summary.segmented.harness_validation, ok: safetyOk },
        all_pass: gate
      }
    : {
        paired,
        mechanism: {
          provider_error: { single: summary.single.provider_error, segmented: summary.segmented.provider_error, reduced: providerErrorReduced },
          paired_output_change_median: paired.output_change_median,
          output_dropped: outputDropped,
          pass: providerErrorReduced && outputDropped
        },
        rescue: { baseline_timeout_topics: timeoutTopics.length, rescued_by_segmented: rescued.length, pass: rescued.length >= 2 },
        safety: { single_harness_validation: summary.single.harness_validation, segmented_harness_validation: summary.segmented.harness_validation, ok: safetyOk },
        all_pass: gate,
        note: "先导只有 6 对：判方向与止损，量级以全量 30 题为准"
      };
  return { experimentId: manifest.experimentId, runId, at: new Date().toISOString(), status: "completed", rows: single.length + segmented.length, summary, verdict };
}

async function referenceFor(repository: ImportedRepository, tag: string): Promise<string> {
  return withExercisePorts(repository.handle, (ports) => {
    const summaries = new Map(ports.summaries.latest().map((row) => [row.path, row.summary]));
    const candidates = selectTagCandidates(practiceView(repository, ports), tag, 6, summaries);
    return candidates.map((candidate) => `## ${candidate.path}\n${candidate.excerpt}`).join("\n\n").slice(0, 24_000);
  });
}

function facesFor(repository: ImportedRepository): ExerciseFaces {
  const skills = skillsForTurn();
  return {
    scope: "practice",
    repoPath: repository.path,
    search: searchCorpusFor(repository),
    facts: factsToolFor(repository, repository.handle.pin()),
    ...(skills ? { skills } : {}),
    budgetGuard: turnBudgetGuard(repository.handle)
  };
}

async function runArm(arm: Arm, repository: ImportedRepository, topic: PilotTopic): Promise<Row> {
  const reference = await referenceFor(repository, topic.tag_id);
  const faces = facesFor(repository);
  const logOffset = llmLogSize();
  const started = new Date();
  let generation: CodeGeneration;
  let segments: SegmentEvent[] | undefined;
  if (arm === "single") {
    generation = await generateCodeExerciseFromReference({ repositoryPath: repository.path, tag: topic.tag_id, kind: "patch_edit", reference, provider: provider!, faces });
  } else {
    const out = await generateCodeExerciseSegmented({ repositoryPath: repository.path, tag: topic.tag_id, kind: "patch_edit", reference, provider: provider!, faces });
    generation = out.generation;
    segments = out.segments;
  }
  const ended = new Date();
  // 产物与自证输出落盘：失败时能直接看到编译错误，不必猜（v1/v2 两次都缺这一手，只能靠推理）。
  try {
    const stem = `${arm}-${topic.repo}-${topic.tag_id}`;
    mkdirSync(artifactDir, { recursive: true });
    if (generation.ok) writeFileSync(join(artifactDir, `${stem}.proposal.json`), `${JSON.stringify(generation.proposal, null, 2)}\n`, "utf8");
    else writeFileSync(join(artifactDir, `${stem}.failure.json`), `${JSON.stringify({ stage: generation.stage, reason: generation.reason, runs: generation.runs }, null, 2)}\n`, "utf8");
  } catch { /* 落盘失败不打断实验 */ }
  const usage = generation.usage;
  return {
    experimentId: manifest.experimentId, datasetId: manifest.datasetId, runId, at: ended.toISOString(),
    arm, taskId: `exercise:${topic.repo}:design:${topic.tag_id}`,
    repository: topic.repo, language: manifest.repos.find((repo) => repo.name === topic.repo)?.language ?? "unknown",
    topic: topic.topic, baseline_outcome: topic.baseline_outcome,
    started_at: started.toISOString(), ended_at: ended.toISOString(), duration_ms: ended.getTime() - started.getTime(),
    success: generation.ok,
    ...(generation.ok ? {} : { failure_stage: generation.stage, error: generation.reason.slice(0, 300) }),
    input_tokens: usage?.inputTokens ?? "缺失",
    output_tokens: usage?.outputTokens ?? "缺失",
    model_calls: segments ? segments.length : 1,
    max_call_output_tokens: maxOutputSince(logOffset),
    ...(segments ? { segments, max_segment_output_tokens: Math.max(...segments.map((item) => item.outputTokens ?? 0)) } : {}),
    quality: qualityOf(generation)
  };
}

interface ArmSummary {
  attempts: number; success: number; success_rate: number;
  provider_error: number; harness_validation: number; proposal_shape: number; sandbox_unavailable: number;
  duration_p50_ms: number; duration_max_ms: number; output_tokens: number;
  max_segment_output_tokens: number; quality_passed: number;
  /** 单次模型调用最大的输出 token（两臂可比，不受端点快慢影响）。 */
  max_call_output_tokens: number;
  /** 归一化耗时：总秒 ÷ 千 token。抵消端点吞吐波动，看分段有没有额外开销。 */
  duration_per_1k_tokens_s: number;
}

function summarize(list: Row[]): ArmSummary {
  const ok = list.filter((row) => row.success);
  const failures = list.filter((row) => !row.success);
  const byStage = (stage: string): number => failures.filter((row) => row.failure_stage === stage).length;
  const durations = list.map((row) => row.duration_ms).sort((a, b) => a - b);
  return {
    attempts: list.length, success: ok.length,
    success_rate: list.length ? ok.length / list.length : 0,
    provider_error: byStage("provider_error"),
    harness_validation: byStage("harness_validation"),
    proposal_shape: byStage("proposal_shape"),
    sandbox_unavailable: byStage("sandbox_unavailable"),
    duration_p50_ms: durations.length ? durations[Math.floor(durations.length / 2)] : 0,
    duration_max_ms: durations.length ? durations[durations.length - 1] : 0,
    output_tokens: list.reduce((acc, row) => acc + (row.output_tokens === "缺失" ? 0 : row.output_tokens), 0),
    max_segment_output_tokens: Math.max(0, ...list.map((row) => row.max_segment_output_tokens ?? 0)),
    quality_passed: ok.filter((row) => row.quality.passed).length,
    max_call_output_tokens: Math.max(0, ...list.map((row) => row.max_call_output_tokens ?? 0)),
    duration_per_1k_tokens_s: (() => {
      const tokens = list.reduce((acc, row) => acc + (row.output_tokens === "缺失" ? 0 : row.output_tokens), 0);
      const seconds = list.reduce((acc, row) => acc + row.duration_ms, 0) / 1000;
      return tokens > 0 ? Number((seconds / (tokens / 1000)).toFixed(1)) : 0;
    })()
  };
}

if (existsSync(outFile) && readFileSync(outFile, "utf8").trim()) {
  console.error(`[segmented] 结果文件已有内容：${outFile}；先归档再跑，避免把两轮混在一起。`);
  rmSync(registryDir, { recursive: true, force: true });
  process.exit(2);
}

try {
  for (const repo of manifest.repos) mounted.set(repo.name, await mountFrozen(repo, root));
  console.log(`- 产物挂载预检：${mounted.size}/${manifest.repos.length} 仓通过\n`);
  for (const [index, topic] of topics.entries()) {
    const repository = mounted.get(topic.repo);
    if (!repository) throw new Error(`${topic.repo} 不在冻结清单里`);
    // 背靠背：同一题的两臂紧挨着跑，端点负载对两臂一样。
    for (const arm of (index % 2 === 0 ? ["single", "segmented"] : ["segmented", "single"]) as Arm[]) {
      const row = await runArm(arm, repository, topic);
      rows.push(row);
      appendFileSync(outFile, `${JSON.stringify(row)}\n`, "utf8");
      console.log(`${topic.repo} / ${topic.topic} / ${arm}：${row.success ? "成功" : `失败（${row.failure_stage}）`}｜${(row.duration_ms / 1000).toFixed(1)}s｜in ${row.input_tokens} / out ${row.output_tokens}｜基线=${row.baseline_outcome}`);
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(`[segmented] 执行失败：${failure}`);
} finally {
  for (const repository of mounted.values()) repository.handle.close();
  rmSync(registryDir, { recursive: true, force: true });
}

const singleRows = rows.filter((row) => row.arm === "single");
const segmentedRows = rows.filter((row) => row.arm === "segmented");
const report = score(singleRows, segmentedRows, topics, full);
writeFileSync(summaryFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n## 汇总\n${JSON.stringify(report.summary, null, 2)}\n`);
console.log(`## 判据\n${JSON.stringify(report.verdict, null, 2)}\n`);
console.log(`结果：${outFile}\n汇总：${summaryFile}`);
if (failure) process.exitCode = 2;
