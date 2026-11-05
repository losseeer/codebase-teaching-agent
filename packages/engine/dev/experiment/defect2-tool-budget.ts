/**
  [DEV ONLY] defect2-tool-budget-2026-11：缺陷 2 单变量消融（付费、串行、按任务配对）。

  两臂都调同一个产品函数 generateCodeExerciseFromReference，唯一差异是
  ExerciseFaces.toolChoiceRequiredRounds（0 = 产品现状 / 3 = 前 3 个工具轮强制
  tool_choice=required）。对照臂同轮重跑，不用 11-04 存档。

  阶段：--dry | --phase=smoke（默认）| --phase=full | --from=N
  smoke 跑前 3 对 → evaluateGate → 通过才继续跑剩余 27 对，合计 30 对。
  冒烟的 3 对计入全量结果（同一连续运行）；gate 只作止损，不用于筛选数据。
*/
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadDotEnv } from "../../src/boot.js";
import type { ExerciseFaces } from "../../src/exercises/turn-faces.js";
import type { ImportedRepository } from "../../src/importer/importer.js";
import type { CodeGeneration } from "../../src/exercises/code-generate.js";
import { promptSectionsComplete } from "./design-two-stage.js";
import { evaluateGate, summarizeArm, verdictOf, type Arm, type Row } from "./defect2-gate.js";
import { assertFrozen, csv, mountFrozen, qualityOf, type TopicRow } from "./frozen-dataset.js";

const root = resolve(import.meta.dirname, "../../../..");
const datasetDir = resolve(root, "experiments/defect2-tool-budget-2026-11");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const phase = args.find((arg) => arg.startsWith("--phase="))?.split("=")[1] ?? "smoke";
const fromArg = args.find((arg) => arg.startsWith("--from="));
const fromIndex = fromArg ? Math.max(0, Math.floor(Number(fromArg.split("=")[1]))) : 0;
const runId = process.env.DEFECT2_RUN_ID ?? new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
const manifest = JSON.parse(readFileSync(join(datasetDir, "manifest.json"), "utf8")) as Manifest;

interface Manifest {
  experimentId: string;
  datasetId: string;
  model: { provider: string; name: string; timeoutMs: number; promptVersion: string };
  repos: { name: string; language: string; path: string; commit: string; contentDigest: string; artifactRepositoryId: string; design: boolean }[];
  inputs: { topics: string };
  outputs: { smoke: string; smokeSummary: string; exercises: string; summary: string };
  arms: { id: Arm; label: string; toolChoiceRequiredRounds: number }[];
  protocol: { variable: string; pairing: string; controlRerun: string; stages: string; smokePairs: number; oversizedToolRoundTokens: number; toolRoundBasis: string };
  gate: { minRowsPerArm: number; maxSuccessDeficit: number; maxMedianDurationRatio: number; requireOversizedNotWorse: boolean; systemErrorAborts: string[] };
  criteria: { medianDurationDropAtLeast: number; successRateDropAtMostPp: number; tokenIncreaseAtMost: number; oversizedToolRoundMustDrop: boolean };
}


/** 实验结果行在 defect2-gate.Row 的基础上带上追溯字段。 */
interface ResultRow extends Row {
  experimentId: string; datasetId: string; runId: string; at: string;
  pairIndex: number; armOrder: string;
  repository: string; language: string; exercise_type: "design"; topic: string;
  model: string; prompt_version: string;
  started_at: string; ended_at: string;
  model_calls: number; tool_rounds: number; sandbox_runs: number;
  title?: string;
  quality: Row["quality"] & { prompt_sections_complete: boolean; assertion_count: number; defect_targeted: boolean };
}

const pathOf = (name: string): string => join(datasetDir, name);
const outFile = pathOf(manifest.outputs.exercises);
const smokeFile = pathOf(manifest.outputs.smoke);
const smokeSummaryFile = pathOf(manifest.outputs.smokeSummary);
const summaryFile = pathOf(manifest.outputs.summary);

const topics = csv(pathOf(manifest.inputs.topics)) as unknown as TopicRow[];

/* 汇总 / gate / 判据的纯计算在 defect2-gate.ts，便于离线单测。 */

console.log(`# ${manifest.experimentId}\n`);
console.log(`- 数据集：${manifest.datasetId}（${topics.length} 个设计题任务，${manifest.repos.length} 仓）`);
console.log(`- 变量：${manifest.protocol.variable}`);
console.log(`- runId=${runId} phase=${phase}${dry ? "（dry-run）" : ""}\n`);
try { assertFrozen({ root, repos: manifest.repos, topics }); } catch (error) {
  console.error(`[defect2] 冻结校验失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
if (dry) { console.log("冻结校验通过：内容指纹与产物库身份均与清单一致。"); process.exit(0); }

loadDotEnv();
const registryDir = mkdtempSync(join(tmpdir(), "tutor-defect2-"));
writeFileSync(join(registryDir, "repositories.json"), JSON.stringify({ repositories: manifest.repos.map((repo) => resolve(root, repo.path)) }), "utf8");
process.env.TUTOR_REGISTRY_FILE = join(registryDir, "repositories.json");
process.env.TUTOR_LLM_LOG ??= pathOf("llm.log");

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

async function referenceFor(repository: ImportedRepository, tag: string): Promise<string> {
  return withExercisePorts(repository.handle, (ports) => {
    const summaries = new Map(ports.summaries.latest().map((row) => [row.path, row.summary]));
    const candidates = selectTagCandidates(practiceView(repository, ports), tag, 6, summaries);
    return candidates.map((candidate) => `## ${candidate.path}\n${candidate.excerpt}`).join("\n\n").slice(0, 24_000);
  });
}

async function runOne(repository: ImportedRepository, row: TopicRow, arm: Arm, pairIndex: number, armOrder: string): Promise<ResultRow> {
  const database = repository.handle.pin();
  const counters = { model: 0, toolRounds: 0, toolOutput: 0, oversized: 0 };
  const skills = skillsForTurn();
  const faces: ExerciseFaces = {
    scope: "practice",
    repoPath: repository.path,
    search: searchCorpusFor(repository),
    facts: factsToolFor(repository, database),
    ...(skills ? { skills } : {}),
    budgetGuard: turnBudgetGuard(repository.handle),
    ...(manifest.arms.find((item) => item.id === arm)!.toolChoiceRequiredRounds > 0
      ? { toolChoiceRequiredRounds: manifest.arms.find((item) => item.id === arm)!.toolChoiceRequiredRounds }
      : {}),
    onTrace: (step) => {
      const s = step as unknown as { kind?: string; status?: string; outputTokens?: number; finishReason?: string };
      if (s.kind !== "model" || s.status !== "ok") return;
      counters.model += 1;
      if (s.finishReason === "tool_calls") {
        counters.toolRounds += 1;
        const out = s.outputTokens ?? 0;
        counters.toolOutput += out;
        if (out > manifest.protocol.oversizedToolRoundTokens) counters.oversized += 1;
      }
    }
  };
  const started = new Date();
  let generation: CodeGeneration;
  try {
    const reference = await referenceFor(repository, row.topic);
    generation = await generateCodeExerciseFromReference({
      repositoryPath: repository.path, tag: row.topic, kind: "patch_edit", reference, provider: provider!, faces
    });
  } catch (error) {
    generation = { ok: false, stage: "provider_error", reason: error instanceof Error ? error.message : String(error), runs: [], skillReads: [] };
  } finally {
    repository.handle.unpin();
  }
  const ended = new Date();
  return {
    experimentId: manifest.experimentId, datasetId: manifest.datasetId, runId, at: ended.toISOString(),
    pairIndex, armOrder, arm,
    taskId: `exercise:${row.repo}:design:${row.tag_id}`,
    repository: row.repo, language: manifest.repos.find((repo) => repo.name === row.repo)?.language ?? "unknown",
    exercise_type: "design", topic: row.topic,
    model: provider!.modelVersion, prompt_version: manifest.model.promptVersion,
    started_at: started.toISOString(), ended_at: ended.toISOString(), duration_ms: ended.getTime() - started.getTime(),
    success: generation.ok,
    ...(generation.ok ? { title: generation.proposal.title } : { failure_stage: generation.stage, error: generation.reason.slice(0, 300) }),
    input_tokens: generation.usage?.inputTokens ?? "缺失",
    output_tokens: generation.usage?.outputTokens ?? "缺失",
    model_calls: counters.model, tool_rounds: counters.toolRounds,
    tool_round_output_tokens: counters.toolOutput, oversized_tool_rounds: counters.oversized,
    sandbox_runs: generation.runs.length,
    quality: qualityOf(generation)
  };
}

const arms: Arm[] = ["baseline", "required"];
if (!fromArg && existsSync(outFile) && readFileSync(outFile, "utf8").trim()) {
  throw new Error(`结果文件已有内容：${outFile}；请用 --from=N 续跑或先归档。`);
}

const mounted = new Map<string, ImportedRepository>();
const rows: ResultRow[] = [];
let stopped = false;
let failure: string | undefined;
try {
  for (const repo of manifest.repos) mounted.set(repo.name, await mountFrozen(repo, root));
  console.log(`- 产物挂载预检：${mounted.size}/${manifest.repos.length} 仓通过\n`);

  const smokeEnd = phase === "full" ? 0 : manifest.protocol.smokePairs;
  const startAt = fromArg ? fromIndex : 0;

  for (const [index, row] of topics.entries()) {
    if (index < startAt) continue;
    const repository = mounted.get(row.repo);
    if (!repository) throw new Error(`${row.repo} 不在冻结清单里`);
    const order = index % 2 === 0 ? arms : [...arms].reverse();
    for (const arm of order) {
      const out = await runOne(repository, row, arm, index, order.join(">"));
      rows.push(out);
      appendFileSync(outFile, `${JSON.stringify(out)}\n`, "utf8");
      console.log(`${index} ${row.repo} / ${row.topic} / ${arm}：${out.success ? "成功" : `失败（${out.failure_stage}）`}｜${(out.duration_ms / 1000).toFixed(1)}s｜in ${out.input_tokens} / out ${out.output_tokens}｜超长工具轮 ${out.oversized_tool_rounds}`);
      if (!out.success && /402|余额|insufficient|quota|budget/i.test(`${out.failure_stage ?? ""} ${out.error ?? ""}`)) {
        failure = "检测到余额或预算不足，已停机。"; stopped = true; break;
      }
      // 全量阶段滚动止损：最近 8 次尝试失败 6 次以上，继续跑只是烧钱。
      const recent = rows.slice(-8);
      if (recent.length >= 8 && recent.filter((item) => !item.success).length >= 6) {
        failure = "最近 8 次尝试中 6 次失败，按止损规则停机。"; stopped = true; break;
      }
    }
    if (stopped) break;

    // 冒烟阶段结束：判定 gate，未通过立即停机且不跑全量。
    if (smokeEnd > 0 && index === smokeEnd - 1 && !fromArg) {
      const smokeRows = rows.slice(0, smokeEnd * arms.length);
      writeFileSync(smokeFile, `${smokeRows.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
      const gate = evaluateGate(smokeRows, manifest.gate);
      const smokeSummary = summarizeArm(smokeRows, "baseline");
      const smokeSummaryB = summarizeArm(smokeRows, "required");
      writeFileSync(smokeSummaryFile, `${JSON.stringify({ experimentId: manifest.experimentId, runId, at: new Date().toISOString(), rows: smokeRows.length, gate, summary: { baseline: smokeSummary, required: smokeSummaryB } }, null, 2)}\n`, "utf8");
      console.log(`\n## 冒烟 gate：${gate.pass ? "通过" : "未通过"}\n${JSON.stringify(gate.detail)}\n`);
      if (!gate.pass) {
        failure = `冒烟 gate 未通过：${gate.reasons.join("；")}。未跑全量。`;
        stopped = true;
        break;
      }
      console.log("gate 通过，继续跑剩余配对（冒烟 3 对计入全量结果）。\n");
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(`[defect2] 执行失败：${failure}`);
} finally {
  for (const repository of mounted.values()) repository.handle.close();
  rmSync(registryDir, { recursive: true, force: true });
}

const summary = Object.fromEntries(arms.map((arm) => [arm, summarizeArm(rows, arm)])) as Record<string, Record<string, unknown>>;
const verdict = rows.length === 0 ? { note: "无数据：本轮没有产生任何出题尝试" } : verdictOf(summary, manifest.criteria);
const expectedRows = fromArg ? (topics.length - fromIndex) * arms.length : topics.length * arms.length;
const complete = !stopped && !failure && rows.length === expectedRows;
const report = {
  experimentId: manifest.experimentId, runId, at: new Date().toISOString(),
  status: complete ? "completed" : "failed",
  phase, expectedRows, rows: rows.length, stopped, ...(failure ? { failure } : {}),
  summary, verdict
};
writeFileSync(summaryFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n## 汇总（status=${report.status}）\n`);
for (const arm of arms) {
  const s = summary[arm]!;
  console.log(`- ${arm}：${s.success}/${s.attempts}（${(Number(s.success_rate) * 100).toFixed(1)}%）｜p50 ${(Number(s.duration_p50_ms) / 1000).toFixed(1)}s｜成功题 p50 ${(Number(s.success_duration_p50_ms) / 1000).toFixed(1)}s｜in ${s.input_tokens} / out ${s.output_tokens}｜超长工具轮 ${s.oversized_tool_rounds}｜质量护栏 ${s.quality_passed}`);
}
console.log(`- 判据：${JSON.stringify(verdict)}`);
console.log(`\n结果已写入 ${outFile}；汇总见 ${summaryFile}`);
if (!complete) { console.error(`[defect2] 未完成（期望 ${expectedRows} 次，实际 ${rows.length} 次）。${failure ?? ""}`); process.exitCode = 2; }
