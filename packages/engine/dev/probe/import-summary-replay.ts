/**
  导入摘要截断回放（只读、零 token）：把 L1 摘要截到不同字符上限，重跑固定查询集，比较检索命中。
  用法：`pnpm probe:import-summary <仓库路径> [--queries=<jsonl>] [--limits=60,100,200] [--json]`
*/
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { RepositoryAnalysis } from "@codebase-tutor/domain";

import { loadDotEnv } from "../../src/boot.js";
import { LATEST_SUMMARY_LIMIT } from "../../src/adapter/outbound/persistence/summary-repository.js";
import { indexRepository } from "../../src/indexer/indexer.js";
import { buildDependencyGraph, loadSymbolParser, serializeGraph } from "@codebase-tutor/analysis";
import { buildSearchCorpus, executeSearchCode } from "../../src/source/search-code.js";
import { scoreSearchArm, type SearchCase } from "../eval/scorers.js";

loadDotEnv();

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const args = process.argv.slice(2);
const repoArg = args.find((arg) => !arg.startsWith("--"));
if (!repoArg) {
  console.error("用法：tsx dev/probe/import-summary-replay.ts <仓库路径> [--queries=<jsonl>] [--limits=60,100,200] [--json]");
  process.exit(2);
}
const queriesPath = resolve(root, args.find((arg) => arg.startsWith("--queries="))?.slice("--queries=".length) ?? "experiments/import-2026-11/queries.jsonl");
const limits = (args.find((arg) => arg.startsWith("--limits="))?.slice("--limits=".length) ?? "60,100,200")
  .split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0);
const json = args.includes("--json");

const repositoryPath = resolve(repoArg);
const databaseFile = join(repositoryPath, ".tutor", "tutor.db");
if (!existsSync(databaseFile)) {
  console.error(`tutor.db 缺失：${databaseFile}`);
  process.exit(2);
}

await loadSymbolParser();
const index = indexRepository(repositoryPath);
const graph = buildDependencyGraph(repositoryPath, index.files);
const analysis: RepositoryAnalysis = {
  repositoryId: index.repositoryId,
  generatedAt: new Date().toISOString(),
  graph: serializeGraph(graph),
  implementations: [],
  versionStamp: "import-summary-replay"
};

const database = new DatabaseSync(databaseFile, { readOnly: true });
const fullSummaries = new Map<string, string>();
let rows = 0;
for (const row of database.prepare(`SELECT summary FROM summaries ORDER BY created_at DESC LIMIT ${LATEST_SUMMARY_LIMIT}`).all() as { summary: string }[]) {
  rows += 1;
  try {
    const parsed = JSON.parse(row.summary) as { path?: string; summary?: string };
    if (typeof parsed.path === "string" && typeof parsed.summary === "string" && !fullSummaries.has(parsed.path)) fullSummaries.set(parsed.path, parsed.summary);
  } catch {
    // 非 JSON 行跳过
  }
}
database.close();

const cases = (readFileSync(queriesPath, "utf8").split("\n").filter((line) => line.trim()))
  .map((line) => JSON.parse(line) as SearchCase);

function truncated(limit?: number): Map<string, string> {
  if (!limit) return fullSummaries;
  return new Map([...fullSummaries].map(([path, summary]) => [path, summary.slice(0, limit)]));
}

function score(summaries: Map<string, string>, subset: SearchCase[]) {
  const corpus = buildSearchCorpus(index, analysis, summaries);
  const top = (query: string): string[] => executeSearchCode(corpus, JSON.stringify({ query, limit: 5 })).audit.topPaths;
  return scoreSearchArm(subset, top);
}

const variants = [{ label: "完整", limit: undefined as number | undefined, summaries: fullSummaries }, ...limits.map((limit) => ({ label: `≤${limit}`, limit, summaries: truncated(limit) }))];
const truncatedCounts = limits.map((limit) => [limit, [...fullSummaries.values()].filter((summary) => summary.length > limit).length] as const);

const report = variants.map((variant) => {
  const all = score(variant.summaries, cases);
  const tuning = score(variant.summaries, cases.filter((item) => !item.holdout));
  const holdout = score(variant.summaries, cases.filter((item) => item.holdout));
  return {
    label: variant.label,
    limit: variant.limit,
    hit: { numerator: all.hitRate.numerator, denominator: all.hitRate.denominator },
    meanRecall: all.meanRecall,
    negatives: all.negatives.length,
    negativeWrongHits: all.negatives.filter((item) => item.wrongHits.length > 0).length,
    tuning: { numerator: tuning.hitRate.numerator, denominator: tuning.hitRate.denominator },
    holdout: { numerator: holdout.hitRate.numerator, denominator: holdout.hitRate.denominator }
  };
});

if (json) {
  console.log(JSON.stringify({ repository: repositoryPath, files: index.files.length, summaries: fullSummaries.size, rows, queries: cases.length, truncated: Object.fromEntries(truncatedCounts), variants: report }, null, 2));
} else {
  console.log("# 导入摘要截断回放（只读）");
  console.log();
  console.log(`- 仓库：\`${repositoryPath}\`（索引 ${index.files.length} 文件）`);
  console.log(`- 摘要：${fullSummaries.size} 个文件（读取 ${rows} 行）｜查询集：${cases.length} 条（${queriesPath.replace(`${root}/`, "")}）`);
  console.log(`- 被截断文件数：${truncatedCounts.map(([limit, count]) => `${limit} 字 → ${count} 个`).join("；")}`);
  console.log();
  console.log("| 摘要上限 | hit@5 全部 | 平均 recall | 调优例 hit@5 | 留出例 hit@5 | 负例误命中 |");
  console.log("|---|---|---|---|---|---|");
  for (const row of report) {
    const pct = (value: { numerator: number; denominator: number }) => `${((value.numerator / Math.max(1, value.denominator)) * 100).toFixed(1)}%（${value.numerator}/${value.denominator}）`;
    console.log(`| ${row.label} | ${pct(row.hit)} | ${(row.meanRecall * 100).toFixed(1)}% | ${pct(row.tuning)} | ${pct(row.holdout)} | ${row.negativeWrongHits}/${row.negatives} |`);
  }
}
