/**
  出题修复策略实验（付费）：同一主题跑 A/B 两臂，记录成功率、耗时与 token。
  A = 现状：形状错误不修复，自证失败最多修复一次。
  B = 形状错误与自证失败都可修复，最多两次修复。
  用法：pnpm experiment:exercise-repair [--pairs 5] [--dry]
*/
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExerciseFaces } from "../../src/exercises/turn-faces.js";
import type { RepairPolicy } from "../../src/exercises/code-generate.js";

import { loadDotEnv } from "../../src/boot.js";

const REPOS: { path: string; tags: string[] }[] = [
  // 难仓放前面：额度有限时先保证 agent2/Xingyan 有数据
  { path: "/Users/dedsecczk/Dev/dianping/dianping-agent2", tags: ["意图理解", "工具调用", "状态机", "记忆", "检索增强", "提示词模板", "流式输出", "异常重试"] },
  { path: "/Users/dedsecczk/Dev/Xingyan-ShortLink-Platform", tags: ["操作系统", "计算机网络", "数据结构", "短链生成", "重定向", "分库分表", "分布式ID", "限流"] },
  { path: "/Users/dedsecczk/Dev/dianping/dianping-backend", tags: ["秒杀", "优惠券", "订单", "线程池", "缓存", "登录鉴权", "数据库事务", "分布式锁", "消息队列", "接口幂等"] },
  // 少量前端：只保留 4 个通用前端主题
  { path: "/Users/dedsecczk/Dev/dianping/dianping-frontend", tags: ["组件设计", "状态管理", "路由守卫", "请求封装"] }
];

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const pairsArg = args.find((arg) => arg.startsWith("--pairs="));
const pairLimit = pairsArg ? Math.max(1, Math.floor(Number(pairsArg.split("=")[1]))) : 5;
const startArg = args.find((arg) => arg.startsWith("--start="));
const tagStart = startArg ? Math.max(0, Math.floor(Number(startArg.split("=")[1]))) : 0;
const outArg = args.find((arg) => arg.startsWith("--out="));
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const outFile = outArg ? outArg.slice("--out=".length) : join(tmpdir(), `tutor-exercise-repair-${runId}.jsonl`);

const ARMS: { id: "A" | "B"; repair: RepairPolicy }[] = [
  { id: "A", repair: { maxRetries: 1, retryShape: false } },
  { id: "B", repair: { maxRetries: 2, retryShape: true } }
];

interface Row {
  repo: string;
  tag: string;
  arm: "A" | "B";
  model: string;
  ok: boolean;
  stage?: string;
  reason?: string;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  modelCalls: number;
  toolCalls: number;
  sandboxRuns: number;
  title?: string;
  error?: string;
}

const scenarios = REPOS.flatMap((repo) => repo.tags.slice(tagStart, pairLimit).map((tag) => ({ repo, tag })));
console.log(`# 出题修复策略实验\n`);
console.log(`- 配对：${scenarios.length} 个主题 × 2 臂 = ${scenarios.length * 2} 次尝试`);
console.log(`- 结果：${outFile}${dry ? "（dry-run，不写结果）" : ""}\n`);
if (dry) {
  for (const scenario of scenarios) console.log(`  · ${scenario.repo.path.split("/").pop()} / ${scenario.tag}`);
  process.exit(0);
}

loadDotEnv();
// 不读用户地址簿：用临时清单挂载这三个仓，避免实验改动用户配置
const registryDir = mkdtempSync(join(tmpdir(), "tutor-exp-registry-"));
const registryFile = join(registryDir, "repositories.json");
writeFileSync(registryFile, JSON.stringify({ repositories: REPOS.map((repo) => repo.path) }), "utf8");
process.env.TUTOR_REGISTRY_FILE = registryFile;

const { importer, lightLlm } = await import("../../src/infrastructure/composition-root.js");
const { ensureIsolation } = await import("../../src/adapter/outbound/sandbox/isolation.js");
const { generateCodeExerciseFromReference } = await import("../../src/exercises/code-generate.js");
const { selectTagCandidates } = await import("../../src/exercises/exercises.js");
const { withExercisePorts, practiceView } = await import("../../src/infrastructure/exercise-ports.js");
const { skillsForTurn } = await import("../../src/application/orchestration/scoped-turn.js");
const { searchCorpusFor, turnBudgetGuard } = await import("../../src/application/orchestration/paid-turn.js");
const { factsToolFor } = await import("../../src/infrastructure/canvas-tools.js");

const provider = lightLlm();
if (!provider) {
  console.log("未执行：没有解析出 light 模型档（未配置或预算已到线）。");
  process.exit(0);
}
const isolation = await ensureIsolation();
if (isolation.level !== "enforced") {
  console.log(`未执行：沙箱不可用（${isolation.reason}）。`);
  process.exit(0);
}

const rows: Row[] = [];

async function referenceFor(repository: import("../../src/importer/importer.js").ImportedRepository, tag: string): Promise<string> {
  return withExercisePorts(repository.handle, (ports) => {
    const summaries = new Map(ports.summaries.latest().map((row) => [row.path, row.summary]));
    const candidates = selectTagCandidates(practiceView(repository, ports), tag, 6, summaries);
    return candidates.map((candidate) => `## ${candidate.path}\n${candidate.excerpt}`).join("\n\n").slice(0, 24_000);
  });
}

async function runOne(repository: import("../../src/importer/importer.js").ImportedRepository, tag: string, arm: (typeof ARMS)[number]): Promise<Row> {
  const database = repository.handle.pin();
  let modelCalls = 0;
  let toolCalls = 0;
  const onTrace = (step: { kind: string; status: string }): void => {
    if (step.status === "ok" && step.kind === "model") modelCalls += 1;
    if (step.status === "ok" && step.kind === "tool") toolCalls += 1;
  };
  const skills = skillsForTurn();
  const faces: ExerciseFaces = {
    scope: "practice",
    repoPath: repository.path,
    search: searchCorpusFor(repository),
    facts: factsToolFor(repository, database),
    ...(skills ? { skills } : {}),
    budgetGuard: turnBudgetGuard(repository.handle),
    onTrace
  };
  const start = Date.now();
  try {
    const reference = await referenceFor(repository, tag);
    const generation = await generateCodeExerciseFromReference({
      repositoryPath: repository.path,
      tag,
      kind: "patch_edit",
      reference,
      provider: provider!,
      faces,
      repair: arm.repair
    });
    const elapsedMs = Date.now() - start;
    return {
      repo: repository.path.split("/").pop() ?? repository.path,
      tag,
      arm: arm.id,
      model: provider!.modelVersion,
      ok: generation.ok,
      ...(generation.ok ? { stage: undefined, title: generation.proposal.title } : { stage: generation.stage, reason: generation.reason.slice(0, 300) }),
      elapsedMs,
      inputTokens: generation.usage?.inputTokens ?? 0,
      outputTokens: generation.usage?.outputTokens ?? 0,
      cacheHitTokens: generation.usage?.promptCacheHitTokens ?? 0,
      modelCalls,
      toolCalls,
      sandboxRuns: generation.runs.length
    };
  } catch (error) {
    return {
      repo: repository.path.split("/").pop() ?? repository.path,
      tag,
      arm: arm.id,
      model: provider!.modelVersion,
      ok: false,
      stage: "exception",
      elapsedMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      modelCalls,
      toolCalls,
      sandboxRuns: 0,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error)
    };
  } finally {
    repository.handle.unpin();
  }
}

for (const [index, scenario] of scenarios.entries()) {
  const entry = importer.catalog().find((item) => resolve(item.repositoryPath) === resolve(scenario.repo.path));
  const mounted = entry ? importer.ensureMounted(entry.repositoryId) : undefined;
  if (!mounted?.ok) {
    console.log(`跳过 ${scenario.repo.path}：${mounted ? mounted.message : "不在临时地址簿里"}`);
    continue;
  }
  for (const arm of index % 2 === 0 ? ARMS : [...ARMS].reverse()) {
    const row = await runOne(mounted.repository, scenario.tag, arm);
    rows.push(row);
    appendFileSync(outFile, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, "utf8");
    console.log(`${row.repo} / ${row.tag} / ${row.arm}：${row.ok ? `成功（${row.title ?? ""}）` : `失败（${row.stage ?? "?"}）`}｜${Math.round(row.elapsedMs / 100) / 10}s｜in ${row.inputTokens} / out ${row.outputTokens}`);
    // 余额/预算类错误立即停：不要把剩余配对继续烧掉
    if (!row.ok && /402|余额|insufficient|quota|budget/i.test(`${row.stage ?? ""} ${row.reason ?? ""} ${row.error ?? ""}`)) {
      console.log("\n检测到余额或预算不足，实验已停在当前配对；请充值后从结果文件续跑。");
      rmSync(registryDir, { recursive: true, force: true });
      process.exit(2);
    }
  }
}

rmSync(registryDir, { recursive: true, force: true });
const summarize = (arm: "A" | "B") => {
  const subset = rows.filter((row) => row.arm === arm);
  const ok = subset.filter((row) => row.ok).length;
  const time = subset.reduce((sum, row) => sum + row.elapsedMs, 0);
  const input = subset.reduce((sum, row) => sum + row.inputTokens, 0);
  const output = subset.reduce((sum, row) => sum + row.outputTokens, 0);
  return { n: subset.length, ok, rate: subset.length ? ok / subset.length : 0, avgMs: subset.length ? time / subset.length : 0, input, output };
};
console.log(`\n## 汇总\n`);
for (const arm of ARMS) {
  const summary = summarize(arm.id);
  console.log(`- ${arm.id}：${summary.ok}/${summary.n}（${(summary.rate * 100).toFixed(1)}%）｜平均 ${Math.round(summary.avgMs / 100) / 10}s｜in ${summary.input} / out ${summary.output}`);
}
const aOk = new Set(rows.filter((row) => row.arm === "A" && row.ok).map((row) => `${row.repo}/${row.tag}`));
const bOk = new Set(rows.filter((row) => row.arm === "B" && row.ok).map((row) => `${row.repo}/${row.tag}`));
const b = [...bOk].filter((key) => !aOk.has(key)).length;
const c = [...aOk].filter((key) => !bOk.has(key)).length;
console.log(`- 配对净翻回：b=${b}（A 败 B 成），c=${c}（A 成 B 败），b-c=${b - c}`);
console.log(`\n结果已写入 ${outFile}`);
