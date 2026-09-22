import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { RepositoryAnalysis, RepositoryFlow } from "@codebase-tutor/shared";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph, serializeGraph } from "../depgraph/graph.js";
import { loadSymbolParser } from "../depgraph/parser.js";
import { buildSearchCorpus, executeSearchCode } from "../source/search-code.js";
import { scoreFlowArtifacts, scoreSearchArm, type SearchCase } from "../eval/scorers.js";

/**
  B 档评测 runner（第 1 刀：零 token 确定性判分，设计方案 §10 第 2 档的机器检查部分）。
  全程只读：产物取自 <repo>/.tutor/tutor.db，索引/依赖图在本地重算，不碰引擎、不写任何文件。
  LLM 真跑与表达质量裁判不在这一刀里（回合落盘是其前置）。

  用法：pnpm phaseB:eval [仓库路径]（缺省取 repositories.json 唯一/首个仓库）
*/

const here = dirname(fileURLToPath(import.meta.url));
const tutorHome = join(homedir(), ".codebase-tutor");
const repositoryPath = (() => {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("-"));
  if (arg) return resolve(arg);
  const registry = join(tutorHome, "repositories.json");
  if (!existsSync(registry)) throw new Error("未给仓库路径，且 repositories.json 不存在");
  const list = (JSON.parse(readFileSync(registry, "utf8")).repositories ?? []) as string[];
  if (!list.length) throw new Error("repositories.json 为空");
  return list[0];
})();

function pct(numerator: number, denominator: number): string {
  return denominator ? `${((numerator / denominator) * 100).toFixed(1)}%（${numerator}/${denominator}）` : "未执行";
}

const out: string[] = [];
const emit = (line = ""): void => { out.push(line); };

const index = indexRepository(repositoryPath);
const files = new Map(index.files.map((file) => [file.path, file.lines]));
const databaseFile = join(repositoryPath, ".tutor", "tutor.db");
if (!existsSync(databaseFile)) {
  console.log(`# B 档评测报告\n\n- 仓库 \`${repositoryPath}\`：**未执行**（tutor.db 缺失，flow 产物与 L1 摘要都没有数据源）`);
  process.exit(0);
}
const database = new DatabaseSync(databaseFile, { readOnly: true });

const flows: RepositoryFlow[] = [];
for (const row of database.prepare("SELECT payload FROM layer_cache WHERE cache_key LIKE 'flow:%'").all() as { payload: string }[]) {
  try {
    const parsed = JSON.parse(row.payload) as { flow?: RepositoryFlow };
    if (parsed.flow) flows.push(parsed.flow);
  } catch { /* 脏行跳过：评测脚本不修数据 */ }
}

// L1 摘要按「同文件最新一行」取（与 metrics 同口径），作为检索语料的「摘要在上」臂
const summaries = new Map<string, string>();
for (const row of database.prepare("SELECT summary FROM summaries ORDER BY created_at DESC").all() as { summary: string }[]) {
  try {
    const parsed = JSON.parse(row.summary) as { path?: string; summary?: string };
    if (typeof parsed.path === "string" && typeof parsed.summary === "string" && !summaries.has(parsed.path)) summaries.set(parsed.path, parsed.summary);
  } catch { /* 旧纯文本行：键口径变更前产物，跳过 */ }
}
database.close();

const caseDirectory = join(here, "..", "eval", "cases");
const caseFiles = readdirSync(caseDirectory).filter((name) => name.endsWith(".json"));

// 摘要含标识符率：slice-v2 口径（「至少点出一个真实英文标识符」）的直接读数；
// 连续 ≥5 位字母数字串才算，泛化短词（get、api）不计——与判分器同为零 token。
const withIdentifier = [...summaries.values()].filter((text) => /[A-Za-z][A-Za-z0-9]{4,}/.test(text)).length;

emit(`# B 档评测报告（零 token 确定性判分）`);
emit(`生成时间：${new Date().toISOString()}｜仓库：\`${repositoryPath}\`（索引 ${index.files.length} 文件）`);
emit(`数据源：layer_cache flow ${flows.length} 条；L1 摘要 ${summaries.size} 个文件（含英文标识符 ${pct(withIdentifier, summaries.size)}）；用例文件 ${caseFiles.length} 份`);
emit();

// ---------- 1/2. 存量 flow 产物：引用落地 + 边证据可核对 ----------
emit("## 1. 产物引用落地（模型写的文本里，每个 文件:行号 都要真实存在）");
emit("## 2. 边证据可核对（code 边须引到本边端点文件；static 边须至少引到一个存在文件）");
if (!flows.length) {
  emit("- **未执行**：layer_cache 无 flow 行。");
} else {
  const score = scoreFlowArtifacts(flows, files);
  emit(`- 引用落地：${pct(score.refs.ok, score.refs.total)}；问题引用 ${score.refs.problems.length} 条`);
  for (const problem of score.refs.problems.slice(0, 10)) emit(`  - \`${problem.raw}\` —— ${problem.why}`);
  if (score.refs.problems.length > 10) emit(`  - …另有 ${score.refs.problems.length - 10} 条`);
  emit(`- code 边证据核对：${pct(score.code.ok, score.code.total)}`);
  for (const bad of score.code.bad.slice(0, 10)) emit(`  - ${bad.key}：\`${bad.evidence}\``);
  if (score.code.bad.length > 10) emit(`  - …另有 ${score.code.bad.length - 10} 条`);
  emit(`- static 边证据核对：${pct(score.static.ok, score.static.total)}`);
  for (const bad of score.static.bad.slice(0, 10)) emit(`  - ${bad.key}：\`${bad.evidence}\``);
  if (score.static.bad.length > 10) emit(`  - …另有 ${score.static.bad.length - 10} 条`);
}
emit();

// ---------- 3. 检索 gold 命中（离线重放，摘要上/不上两臂） ----------
emit("## 3. 检索 gold 命中（hit@5 / recall@5，摘要臂 vs 无摘要臂）");
await loadSymbolParser();
const graph = buildDependencyGraph(repositoryPath, index.files);
const analysis: RepositoryAnalysis = {
  repositoryId: index.repositoryId,
  generatedAt: new Date().toISOString(),
  graph: serializeGraph(graph),
  implementations: [],
  quality: { generatedAt: new Date().toISOString(), micro: [], macro: [] },
  versionStamp: "eval"
};
const corpusWith = buildSearchCorpus(index, analysis, summaries);
const corpusWithout = buildSearchCorpus(index, analysis, new Map());
let anyCaseRan = false;
// 用例集按「仓库路径包含 repository 名」匹配，但包含关系会串仓（dianping ⊂ dianping-agent2）：
// 多个用例集都命中时只跑最长（最具体）的那个，其余显式标注接管关系，不静默跳过。
const caseDocs = caseFiles.map((name) => ({ name, doc: JSON.parse(readFileSync(join(caseDirectory, name), "utf8")) as { repository: string; cases: SearchCase[] } }));
const matched = caseDocs.filter((entry) => repositoryPath.toLowerCase().includes(entry.doc.repository.toLowerCase()));
const winner = matched.length ? matched.reduce((best, entry) => (entry.doc.repository.length > best.doc.repository.length ? entry : best)) : undefined;
for (const { name, doc } of caseDocs) {
  if (!repositoryPath.toLowerCase().includes(doc.repository.toLowerCase())) {
    emit(`- \`${name}\`（repository=${doc.repository}）：与当前仓库不匹配，未执行`);
    continue;
  }
  if (winner && name !== winner.name) {
    emit(`- \`${name}\`（repository=${doc.repository}）：被更具体的用例集 \`${winner.name}\`（repository=${winner.doc.repository}）接管，未执行`);
    continue;
  }
  anyCaseRan = true;
  const topOf = (corpus: typeof corpusWith) => (query: string) => executeSearchCode(corpus, JSON.stringify({ query, limit: 5 })).audit.topPaths;
  const holdoutIds = new Set(doc.cases.filter((item) => item.holdout).map((item) => item.id));
  const withArm = scoreSearchArm(doc.cases, topOf(corpusWith));
  const withoutArm = scoreSearchArm(doc.cases, topOf(corpusWithout));
  emit();
  emit(`### ${name}`);
  emit();
  emit("| 用例 | 摘要在上（hit·recall｜top1） | 无摘要（hit·recall｜top1） |");
  emit("|---|---|---|");
  for (let i = 0; i < withArm.perCase.length; i += 1) {
    const good = withArm.perCase[i];
    const bare = withoutArm.perCase[i];
    const show = (arm: typeof good) => `${arm.hit ? "✅" : "❌"} ${(arm.recall * 100).toFixed(0)}%｜${arm.top[0]?.split("/").pop() ?? "（零命中）"}`;
    emit(`| ${holdoutIds.has(good.id) ? `${good.id}（留）` : good.id} | ${show(good)} | ${show(bare)} |`);
  }
  emit();
  // 调优例与留出例分列报数：只有调优例涨 = 「对着考纲出题」的证据；两边同涨才是口径真的变好
  const cohorts = [
    { label: "调优", cases: doc.cases.filter((item) => !item.holdout) },
    { label: "留出", cases: doc.cases.filter((item) => item.holdout) }
  ].filter((cohort) => cohort.cases.length);
  for (const cohort of cohorts) {
    const withCohort = scoreSearchArm(cohort.cases, topOf(corpusWith));
    const withoutCohort = scoreSearchArm(cohort.cases, topOf(corpusWithout));
    emit(`- 「${cohort.label}」摘要在上：hit@5 ${pct(withCohort.hitRate.numerator, withCohort.hitRate.denominator)}，平均 recall ${((withCohort.meanRecall || 0) * 100).toFixed(1)}%`);
    emit(`- 「${cohort.label}」无摘要：hit@5 ${pct(withoutCohort.hitRate.numerator, withoutCohort.hitRate.denominator)}，平均 recall ${((withoutCohort.meanRecall || 0) * 100).toFixed(1)}%`);
    const negatives = [...withCohort.negatives, ...withoutCohort.negatives];
    if (negatives.length) {
      const wrong = negatives.filter((item) => item.wrongHits.length > 0);
      emit(`- 「${cohort.label}」负例：${negatives.length / 2} 条，误命中 ${pct(wrong.length, negatives.length)}${wrong.length ? `（${wrong.map((item) => `${item.id}→${item.wrongHits[0]?.split("/").pop()}`).join("、")}）` : ""}`);
    }
  }
}
if (!anyCaseRan) emit("- **未执行**：没有匹配当前仓库的用例文件。");
emit();
console.log(out.join("\n"));
