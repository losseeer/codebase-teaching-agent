import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { RepositoryAnalysis } from "@codebase-tutor/domain";

import { loadDotEnv } from "../../src/boot.js";
import { LATEST_SUMMARY_LIMIT } from "../../src/adapter/outbound/persistence/summary-repository.js";
import { indexRepository } from "../../src/indexer/indexer.js";
import { buildDependencyGraph, serializeGraph } from "@codebase-tutor/analysis";
import { loadSymbolParser } from "@codebase-tutor/analysis";
import { buildSearchCorpus, executeSearchCode } from "../../src/source/search-code.js";
import { segmentForLookup } from "@codebase-tutor/platform";
import { readJournal } from "../../src/adapter/outbound/persistence/journal.js";
import type { TeachTurn } from "../../src/application/runtime/turn-invariants.js";
import { scoreSearchArm, scoreTeachInvariants, type SearchCase } from "../eval/scorers.js";

/**
  评测 runner：零 token 确定性判分，全程只读。
  LLM 真跑与表达质量裁判在 phaseB:judge。
  用法：`pnpm phaseB:eval [仓库路径]`
*/

loadDotEnv();

const here = dirname(fileURLToPath(import.meta.url));
const tutorHome = join(homedir(), ".codebase-tutor");
const repositoryPath = (() => {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("-"));
  if (arg) return resolve(arg);
  const registry = join(tutorHome, "repositories.json");
  if (!existsSync(registry)) throw new Error("未给仓库路径，且 repositories.json 不存在");
  const list = (JSON.parse(readFileSync(registry, "utf8")).repositories ?? []) as string[];
  if (!list.length) throw new Error("repositories.json 为空");
  // 地址簿按最近使用在后排序。
  return list.at(-1)!;
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
  console.log(`# B 档评测报告\n\n- 仓库 \`${repositoryPath}\`：未执行（tutor.db 缺失，L1 摘要没有数据源）`);
  process.exit(0);
}
const database = new DatabaseSync(databaseFile, { readOnly: true });

// 摘要按同文件最新一行取，行数上限与产品语料共用一份常量。
const summaries = new Map<string, string>();
for (const row of database.prepare(`SELECT summary FROM summaries ORDER BY created_at DESC LIMIT ${LATEST_SUMMARY_LIMIT}`).all() as { summary: string }[]) {
  try {
    const parsed = JSON.parse(row.summary) as { path?: string; summary?: string };
    if (typeof parsed.path === "string" && typeof parsed.summary === "string" && !summaries.has(parsed.path)) summaries.set(parsed.path, parsed.summary);
  } catch {
    // 非 JSON 行跳过。
  }
}
database.close();

const caseDirectory = join(here, "..", "eval", "cases");
const caseFiles = readdirSync(caseDirectory).filter((name) => name.endsWith(".json"));

// 摘要含标识符率：连续 ≥5 位字母数字串才算，泛化短词不计。
const withIdentifier = [...summaries.values()].filter((text) => /[A-Za-z][A-Za-z0-9]{4,}/.test(text)).length;

emit("# B 档评测报告（零 token 确定性判分）");
emit(`生成时间：${new Date().toISOString()}｜仓库：\`${repositoryPath}\`（索引 ${index.files.length} 文件）`);
emit(`数据源：L1 摘要 ${summaries.size} 个文件（含英文标识符 ${pct(withIdentifier, summaries.size)}）；用例文件 ${caseFiles.length} 份`);
emit();

emit("## 1. 检索 gold 命中（hit@5 / recall@5，词法三臂）");
await loadSymbolParser();
const graph = buildDependencyGraph(repositoryPath, index.files);
const analysis: RepositoryAnalysis = {
  repositoryId: index.repositoryId,
  generatedAt: new Date().toISOString(),
  graph: serializeGraph(graph),
  implementations: [],
  versionStamp: "eval"
};
const corpusWith = buildSearchCorpus(index, analysis, summaries);
const corpusWithout = buildSearchCorpus(index, analysis, new Map());
let anyCaseRan = false;
// 用例集按仓库路径是否包含 repository 名匹配。
// 被更具体（更长且包含本条）的用例集盖住时才让位。
const caseDocs = caseFiles.map((name) => ({ name, doc: JSON.parse(readFileSync(join(caseDirectory, name), "utf8")) as { repository: string; cases: SearchCase[] } }));
const matched = caseDocs.filter((entry) => repositoryPath.toLowerCase().includes(entry.doc.repository.toLowerCase()));
const takenOver = (entry: { name: string; doc: { repository: string } }): string | undefined => {
  const owner = matched.find((other) => other.name !== entry.name
    && other.doc.repository.length > entry.doc.repository.length
    && other.doc.repository.toLowerCase().includes(entry.doc.repository.toLowerCase()));
  return owner?.name;
};

const topOf = (corpus: typeof corpusWith, segment = false) => (query: string) => executeSearchCode(corpus, JSON.stringify({ query: segment ? segmentForLookup(query) : query, limit: 5 })).audit.topPaths;
const productTop = topOf(corpusWith);
const armSet = (cases: SearchCase[]) => [
  { label: "产品现状（含兜底臂+两道闸）", short: "产品现状", arm: scoreSearchArm(cases, productTop) },
  { label: "无摘要", short: "无摘要", arm: scoreSearchArm(cases, topOf(corpusWithout)) },
  { label: "裸切词（无闸，对照上限）", short: "裸切词", arm: scoreSearchArm(cases, topOf(corpusWith, true)) }
];
type ScoredArm = ReturnType<typeof scoreSearchArm>;

for (const { name, doc } of caseDocs) {
  if (!repositoryPath.toLowerCase().includes(doc.repository.toLowerCase())) {
    emit(`- \`${name}\`（repository=${doc.repository}）：与当前仓库不匹配，未执行`);
    continue;
  }
  const owner = takenOver({ name, doc });
  if (owner) {
    emit(`- \`${name}\`（repository=${doc.repository}）：被更具体的用例集 \`${owner}\` 接管，未执行`);
    continue;
  }
  anyCaseRan = true;
  const holdoutIds = new Set(doc.cases.filter((item) => item.holdout).map((item) => item.id));
  // 三臂对照：摘要在上 / 无摘要 / 摘要在上且查询侧切词。
  // 第三臂只改查询侧，语料与打分不变。
  const arms = armSet(doc.cases);
  emit();
  emit(`### ${name}`);
  emit();
  emit(`| 用例 | ${arms.map((entry) => entry.label).join(" | ")} |`);
  emit(`|---|${arms.map(() => "---|").join("")}`);
  const show = (result: ScoredArm["perCase"][number]) => `${result.hit ? "✅" : "❌"} ${(result.recall * 100).toFixed(0)}%｜${result.top[0]?.split("/").pop() ?? "（零命中）"}`;
  for (let i = 0; i < arms[0].arm.perCase.length; i += 1) {
    const cells = arms.map((entry) => entry.arm.perCase[i] ? show(entry.arm.perCase[i]!) : "—");
    emit(`| ${holdoutIds.has(arms[0].arm.perCase[i]!.id) ? `${arms[0].arm.perCase[i]!.id}（留）` : arms[0].arm.perCase[i]!.id} | ${cells.join(" | ")} |`);
  }
  emit();
  // 调优例与留出例分列报数。
  const cohorts = [
    { label: "调优", cases: doc.cases.filter((item) => !item.holdout) },
    { label: "留出", cases: doc.cases.filter((item) => item.holdout) }
  ].filter((cohort) => cohort.cases.length);
  for (const cohort of cohorts) {
    const cohortArms = armSet(cohort.cases);
    const rate = (arm: ScoredArm) => `hit@5 ${pct(arm.hitRate.numerator, arm.hitRate.denominator)}，平均 recall ${((arm.meanRecall || 0) * 100).toFixed(1)}%`;
    for (const entry of cohortArms) emit(`- 「${cohort.label}」${entry.label}：${rate(entry.arm)}`);
    // 负例误命中按臂分列。
    if (cohortArms[0].arm.negatives.length) {
      const parts = cohortArms.map((entry) => {
        const wrong = entry.arm.negatives.filter((item) => item.wrongHits.length > 0);
        return `${entry.short} ${wrong.length}/${entry.arm.negatives.length}${wrong.length ? `（${wrong.map((item) => `${item.id}→${item.wrongHits[0]?.split("/").pop()}`).join("、")}）` : ""}`;
      });
      emit(`- 「${cohort.label}」负例误命中：${parts.join("｜")}`);
    }
  }
}
if (!anyCaseRan) emit("- 未执行：没有匹配当前仓库的用例文件。");
emit();

emit("## 2. 教学法不变量机检（判「设计上写了保证、且文本层可核对」的三条；语义类由 phaseB:judge 裁判）");
const journalEvents = readJournal(repositoryPath);
const teachTurns = assembleTeachTurns(journalEvents);
if (!teachTurns.length) {
  emit("- 未执行：journal 里没有 teach 回合（还没有 `turn_text` 记录，先攒真实教学对话的样本）。");
} else {
  const score = scoreTeachInvariants(teachTurns, files);
  emit(`- 数据源：journal ${journalEvents.length} 事件 → ${score.turns} 个 teach 回合（回复截断致引用核对跳过 ${score.skippedTruncated} 条）`);
  for (const check of score.checks) {
    emit(`- ${check.label}：${pct(check.pass, check.applicable)}｜适用 ${check.applicable} 回合｜出处：${check.source}`);
    for (const miss of check.misses.slice(0, 8)) emit(`  - ⚠️ ${miss.at} 会话 ${miss.sessionId.slice(0, 8)}：${miss.excerpt}`);
    if (check.misses.length > 8) emit(`  - …另有 ${check.misses.length - 8} 条未过`);
  }
}
emit();
console.log(out.join("\n"));

/** 从 journal 事件装配机检视图。 */
function assembleTeachTurns(events: ReturnType<typeof readJournal>): TeachTurn[] {
  const bySession = new Map<string, typeof events>();
  for (const event of events) {
    if (!event.sessionId) continue;
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  }
  const turns: TeachTurn[] = [];
  for (const [sessionId, list] of bySession) {
    const chrono = [...list].sort((a, b) => a.at.localeCompare(b.at));
    for (const event of chrono) {
      if (event.type !== "turn_text" || event.payload.scene !== "teach") continue;
      const at = event.at;
      turns.push({
        sessionId,
        at,
        question: String(event.payload.question ?? ""),
        answer: String(event.payload.answer ?? ""),
        answerTruncated: event.payload.answer_truncated === true
      });
    }
  }
  return turns.sort((a, b) => a.at.localeCompare(b.at));
}
