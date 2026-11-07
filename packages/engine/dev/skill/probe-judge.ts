import { readFileSync } from "node:fs";
import { indexRepository } from "../../src/indexer/indexer.js";
import { buildDependencyGraph } from "@codebase-tutor/analysis";
import { buildImplementationUnits } from "../../src/implementation/units.js";
import { buildSearchCorpus } from "../../src/source/search-code.js";
import { buildPointIndex } from "../../src/exercises/exam-points.js";
import { judgeThemeLandings } from "../../src/exercises/exam-plan.js";

const repoPath = "/Users/dedsecczk/Dev/Xingyan-ShortLink-Platform";
const dir = "/Users/dedsecczk/.codebase-tutor/skills/exercise-code-concepts";
const bodyOf = (name: string, file = "SKILL.md") => {
  try { return readFileSync(`${dir}/${file}`, "utf8"); } catch { return undefined; }
};
const index = indexRepository(repoPath);
const graph = buildDependencyGraph(repoPath, index.files);
const implementations = buildImplementationUnits(repoPath, graph.symbols);
const analysis = { repositoryId: index.repositoryId, generatedAt: "", graph, implementations, versionStamp: "probe" } as never;
const corpus = buildSearchCorpus(index, analysis as never, new Map());
const ctx = { corpus, readText: (p: string) => { try { return readFileSync(`${repoPath}/${p}`, "utf8"); } catch { return undefined; } } };
const judgeIndex = buildPointIndex(bodyOf);

for (const theme of ["高并发", "操作系统", "线程池", "Java特性", "计算机网络"]) {
  const judged = judgeThemeLandings({ theme, index: judgeIndex, ctx });
  if (judged.ok) {
    console.log(`✓ ${theme}: 第${judged.plan.sourceLevel}级  概念[${judged.plan.concepts.join(",")}]  命中条目[${judged.plan.pointIds.join(",") || "无"}]  落点 ${judged.plan.landings.length} 处  推荐 ${judged.plan.listedPoints.length} 条`);
  } else {
    console.log(`✗ ${theme}: ${judged.rejection.reason}  建议：${judged.rejection.suggestions.slice(0, 4).join("、")}`);
  }
}
