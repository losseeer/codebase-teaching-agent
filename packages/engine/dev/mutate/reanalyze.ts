/**
  零 token 的重分析：按当前代码重算依赖图，只回写 `analysis_json` 的 graph（不重算摘要、不改 versionStamp）。
  默认演练模式，回写要加 `--write`；跑完可接着跑 `pnpm l1:reburn`。
  ⚠️ 别在引擎在线时跑：SQLite 单写者，回写会撞锁。
*/
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { indexRepository } from "../../src/indexer/indexer.js";
import { buildDependencyGraph, graphFromData, serializeGraph } from "@codebase-tutor/analysis";
import { loadSymbolParser } from "@codebase-tutor/analysis";
import { classifyFileRoles, fileStructureOf } from "@codebase-tutor/analysis";
import { TutorDatabase } from "../../src/adapter/outbound/persistence/database.js";

const repositoryPath = (() => {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("-"));
  if (arg) return resolve(arg);
  const registry = join(homedir(), ".codebase-tutor", "repositories.json");
  if (!existsSync(registry)) throw new Error("未给仓库路径，且 repositories.json 不存在");
  const list = (JSON.parse(readFileSync(registry, "utf8")).repositories ?? []) as string[];
  if (!list.length) throw new Error("repositories.json 为空");
  return list.at(-1)!;
})();

// 建图前必须加载语法树，缺它就没有 Java 符号与调用边。
await loadSymbolParser();

const index = indexRepository(repositoryPath);
const database = new TutorDatabase(repositoryPath);
const analysis = database.state.analysis(index.repositoryId);
if (!analysis) throw new Error(`仓库 ${repositoryPath} 尚无分析记录（先走 GUI 导入）`);

const before = graphFromData(analysis.graph);
const graph = buildDependencyGraph(repositoryPath, index.files);
const count = (data: typeof before): { imports: number; calls: number; dispatch: number; entries: number } => ({
  imports: [...data.imports.values()].reduce((total, targets) => total + targets.length, 0),
  calls: data.calls.length,
  dispatch: data.dispatch?.length ?? 0,
  entries: data.entrypoints.length
});
const oldCounts = count(before);
const newCounts = count(graph);
console.log(`仓库 ${repositoryPath}`);
console.log(`import 边 ${oldCounts.imports} → ${newCounts.imports}`);
console.log(`调用边 ${oldCounts.calls} → ${newCounts.calls}`);
console.log(`类型派发边 ${oldCounts.dispatch} → ${newCounts.dispatch}`);
console.log(`入口 ${oldCounts.entries} → ${newCounts.entries}`);
const oldRoles = classifyFileRoles(fileStructureOf(index.files, before));
const newRoles = classifyFileRoles(fileStructureOf(index.files, graph));
const tally = (roles: Map<string, string>): string => {
  const counts = new Map<string, number>();
  for (const role of roles.values()) counts.set(role, (counts.get(role) ?? 0) + 1);
  return [...counts.entries()].sort().map(([key, value]) => `${key}=${value}`).join(" ");
};
console.log(`角色（旧图 + 新判据） ${tally(oldRoles)}`);
console.log(`角色（新图 + 新判据） ${tally(newRoles)}`);
for (const edge of (graph.dispatch ?? []).slice(0, 8)) {
  console.log(`  派发 ${edge.subtypePath.split("/").pop()} ${edge.kind} ${edge.supertypePath.split("/").pop()}`);
}
const promoted = index.files.filter((file) => newRoles.get(file.path) === "core" && oldRoles.get(file.path) !== "core").map((file) => file.path);
console.log(`升为主干 ${promoted.length} 个：${promoted.slice(0, 10).map((path) => path.split("/").pop()).join(" ")}`);
const demoted = index.files.filter((file) => newRoles.get(file.path) !== "core" && oldRoles.get(file.path) === "core").map((file) => file.path);
console.log(`从主干落下 ${demoted.length} 个：${demoted.slice(0, 10).map((path) => path.split("/").pop()).join(" ")}`);

/** 一条调用边的比对键：「调用方 → 被调方#方法」。 */
const pairOf = (edge: { callerPath: string; calleePath: string; calleeSymbol?: string }): string =>
  `${edge.callerPath} → ${edge.calleePath}${edge.calleeSymbol ? `#${edge.calleeSymbol.split(":").at(-2)}` : ""}`;
const oldPairs = new Set(before.calls.map(pairOf));
const newPairs = new Set(graph.calls.map(pairOf));
const removed = [...oldPairs].filter((pair) => !newPairs.has(pair));
const added = [...newPairs].filter((pair) => !oldPairs.has(pair));
console.log(`调用边：新增 ${added.length} 条、消失 ${removed.length} 条（去重后按 文件→文件#方法 计）`);
for (const pair of added.slice(0, 8)) console.log(`  + ${pair}`);
for (const pair of removed.slice(0, 8)) console.log(`  - ${pair}`);
if (process.argv.includes("--write")) {
  database.state.saveAnalysis({ ...analysis, graph: serializeGraph(graph) });
  console.log("已回写 analysis_json（--write）");
} else {
  console.log("演练模式：未回写。确认读数后加 --write");
}
database.close();
