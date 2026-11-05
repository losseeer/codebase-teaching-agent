/**
  [DEV ONLY] segmented-generate-2026-11 的先导执行器（6 题 × 2 臂）。

  两臂背靠背连跑：端点负载对两臂公平，否则「超时率」这个主判据没有可比性。
  判分口径完全一致——两臂的最终产物都走产品既有的 finishProposal（同一套形状校验 + 沙箱两跑）。
*/
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const manifest = JSON.parse(readFileSync(join(datasetDir, "manifest.json"), "utf8")) as Manifest;
const topics = csv(join(datasetDir, manifest.inputs.pilotTopics)) as unknown as PilotTopic[];

interface Manifest {
  experimentId: string;
  datasetId: string;
  model: { provider: string; name: string; timeoutMs: number; promptVersion: string };
  repos: FrozenRepo[];
  inputs: { pilotTopics: string; fullTopics: string };
  outputs: { pilot: string; pilotSummary: string };
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
  quality: { prompt_sections_complete: boolean; assertion_count: number; defect_targeted: boolean; passed: boolean };
}

const runId = process.env.SEGMENTED_RUN_ID ?? new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
const outFile = join(datasetDir, manifest.outputs.pilot);
const summaryFile = join(datasetDir, manifest.outputs.pilotSummary);

console.log(`# ${manifest.experimentId}（先导）\n`);
console.log(`- 数据集：${manifest.datasetId}；先导 ${topics.length} 题 × ${manifest.arms.length} 臂`);
console.log(`- 主判据：${manifest.criteria.primary}`);
console.log(`- 先导闸门：${manifest.criteria.pilotGate}\n`);
try {
  assertFrozen({ root, repos: manifest.repos, topics: topics as unknown as TopicRow[], expectedTopics: topics.length, expectedRepos: manifest.repos.length });
} catch (error) {
  console.error(`[segmented] 冻结校验失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (dry) { console.log("冻结校验通过。"); process.exit(0); }

loadDotEnv();
const registryDir = mkdtempSync(join(tmpdir(), "tutor-segmented-"));
writeFileSync(join(registryDir, "repositories.json"), JSON.stringify({ repositories: manifest.repos.map((repo) => resolve(root, repo.path)) }), "utf8");
process.env.TUTOR_REGISTRY_FILE = join(registryDir, "repositories.json");
process.env.TUTOR_LLM_LOG ??= join(datasetDir, "llm.log");

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
    ...(segments ? { segments, max_segment_output_tokens: Math.max(...segments.map((item) => item.outputTokens ?? 0)) } : {}),
    quality: qualityOf(generation)
  };
}

function summarize(list: Row[]): Record<string, unknown> {
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
    quality_passed: ok.filter((row) => row.quality.passed).length
  };
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
const summary = { single: summarize(singleRows), segmented: summarize(segmentedRows) };
const timeoutTopics = topics.filter((topic) => topic.baseline_outcome === "provider_error");
const rescued = timeoutTopics.filter((topic) => segmentedRows.some((row) => row.topic === topic.topic && row.success));
const verdict = {
  baseline_timeout_topics: timeoutTopics.length,
  rescued_by_segmented: rescued.length,
  pilot_gate_pass: rescued.length >= 2,
  primary: { single_provider_error: summary.single.provider_error, segmented_provider_error: summary.segmented.provider_error },
  secondary: { single_success_rate: summary.single.success_rate, segmented_success_rate: summary.segmented.success_rate },
  safety: { single_harness_validation: summary.single.harness_validation, segmented_harness_validation: summary.segmented.harness_validation },
  reference: { single_duration_p50_ms: summary.single.duration_p50_ms, segmented_duration_p50_ms: summary.segmented.duration_p50_ms }
};
const report = { experimentId: manifest.experimentId, runId, at: new Date().toISOString(), status: failure ? "failed" : "completed", rows: rows.length, ...(failure ? { failure } : {}), summary, verdict };
writeFileSync(summaryFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n## 先导汇总\n${JSON.stringify(report.summary, null, 2)}\n`);
console.log(`## 判据\n${JSON.stringify(verdict, null, 2)}\n`);
console.log(`结果：${outFile}\n汇总：${summaryFile}`);
if (failure) process.exitCode = 2;
