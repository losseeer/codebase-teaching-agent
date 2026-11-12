/** 固定主题对照：打印判定结果；有基线时逐条比较，差异返回非 0。`--update` 写基线。 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDependencyGraph } from "@codebase-tutor/analysis";
import { listCatalogUseCase } from "../../src/application/use-case/repositories.js";
import { buildImplementationUnits } from "../../src/implementation/units.js";
import { indexRepository } from "../../src/indexer/indexer.js";
import { buildPointIndex } from "../../src/exercises/exam-points.js";
import { judgeThemeLandings } from "../../src/exercises/exam-plan.js";
import { buildSearchCorpus } from "../../src/source/search-code.js";

interface Result { theme: string; ok: boolean; sourceLevel?: number; concepts?: string[]; pointIds?: string[]; landings?: number }

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, "themes.baseline.json");
const catalog = listCatalogUseCase().repositories;
const explicit = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const repoPath = explicit ?? (catalog.find((entry) => entry.mounted && entry.exists) ?? catalog.find((entry) => entry.exists))?.repositoryPath;
if (!repoPath) {
  console.error("没有可用的已导入仓库：先在界面导入一个仓库。");
  process.exit(1);
}
const dir = "/Users/dedsecczk/.codebase-tutor/skills/exercise-code-concepts";
const bodyOf = (name: string, file = "SKILL.md"): string | undefined => {
  try {
    return readFileSync(join(dir, name, file), "utf8");
  } catch {
    return undefined;
  }
};
const themes = (JSON.parse(readFileSync(join(here, "themes.json"), "utf8")) as { themes: string[] }).themes;

const index = indexRepository(repoPath);
const graph = buildDependencyGraph(repoPath, index.files);
const implementations = buildImplementationUnits(repoPath, graph.symbols);
const analysis = { repositoryId: index.repositoryId, generatedAt: "", graph, implementations, versionStamp: "probe" } as never;
const corpus = buildSearchCorpus(index, analysis as never, new Map());
const ctx = { corpus, readText: (p: string): string | undefined => { try { return readFileSync(`${repoPath}/${p}`, "utf8"); } catch { return undefined; } } };
const judgeIndex = buildPointIndex(bodyOf);

const results: Result[] = themes.map((theme) => {
  const judged = judgeThemeLandings({ theme, index: judgeIndex, ctx });
  if (!judged.ok) return { theme, ok: false };
  return {
    theme,
    ok: true,
    sourceLevel: judged.plan.sourceLevel,
    concepts: [...judged.plan.concepts].sort(),
    pointIds: [...judged.plan.pointIds].sort(),
    landings: judged.plan.landings.length
  };
});
for (const item of results) {
  console.log(item.ok
    ? `通过  ${item.theme}: 层级 ${item.sourceLevel} 落点 ${item.landings} 命中 ${item.pointIds?.join(",") || "无"}`
    : `拒绝  ${item.theme}`);
}
console.log(`\n仓库 ${repoPath}：${index.files.length} 个文件、${graph.symbols.length} 个符号。`);

if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, JSON.stringify({ version: 1, results }, null, 2) + "\n", "utf8");
  console.log(`基线已写入 ${baselinePath}`);
  process.exit(0);
}

let baseline: Result[] | undefined;
try {
  baseline = (JSON.parse(readFileSync(baselinePath, "utf8")) as { results: Result[] }).results;
} catch {
  baseline = undefined;
}
if (!baseline) {
  console.log("基线未建立；本次仅输出结果。确认结果合理后加 --update 生成基线。");
  process.exit(0);
}
let drift = 0;
for (const item of results) {
  const expected = baseline.find((row) => row.theme === item.theme);
  if (!expected) continue;
  const same = expected.ok === item.ok
    && expected.sourceLevel === item.sourceLevel
    && (expected.concepts ?? []).join(",") === (item.concepts ?? []).join(",")
    && (expected.pointIds ?? []).join(",") === (item.pointIds ?? []).join(",");
  if (!same) {
    console.log(`差异  ${item.theme}：基线 ${JSON.stringify(expected)} 当前 ${JSON.stringify(item)}`);
    drift += 1;
  }
}
console.log(`${results.length - drift}/${results.length} 与基线一致。`);
if (drift) process.exit(1);
