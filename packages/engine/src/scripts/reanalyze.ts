/**
  零 token 的重分析：按**当前引擎代码**重算依赖图，只回写 `analysis_json` 里的 graph。

  为什么需要这个脚本：引擎没有「重新分析」这条产品路由（§34.7 记的缺口）。改了建图判据之后，
  不落这一步的话烧出来的还是旧图——上一轮就吃过这个亏（新图只存在于代码里，产物仍是旧的）。
  它只动图：不重算摘要、不动课程树、不改 versionStamp（内容没变就不该谎报新鲜度）。
  跑完该跑 `pnpm l1:reburn`——切片变了的那些文件会被它自己挑出来重烧。

  ⚠️ 别在引擎在线时跑：SQLite 单写者，回写会撞锁。
*/
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph, graphFromData, serializeGraph } from "../depgraph/graph.js";
import { loadSymbolParser } from "../depgraph/parser.js";
import { classifyFileRoles, fileStructureOf } from "../depgraph/roles.js";
import { TutorDatabase } from "../store/database.js";

const repositoryPath = (() => {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("-"));
  if (arg) return resolve(arg);
  const registry = join(homedir(), ".codebase-tutor", "repositories.json");
  if (!existsSync(registry)) throw new Error("未给仓库路径，且 repositories.json 不存在");
  const list = (JSON.parse(readFileSync(registry, "utf8")).repositories ?? []) as string[];
  if (!list.length) throw new Error("repositories.json 为空");
  return list.at(-1)!;
})();

// 语法树不加载就没有 Java 符号，调用边会整片消失——重分析绝不能静默降级成这条
await loadSymbolParser();

const index = indexRepository(repositoryPath);
const database = new TutorDatabase(repositoryPath);
const analysis = database.getAnalysis(index.repositoryId);
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

/**
  调用边的逐条差值：`calls:diff` 的参照是**下界**，判不了变量接收者这一类，
  所以改判据时必须把「少了哪几条、多了哪几条」摊出来人眼看一遍，不能只看总数。
*/
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
  database.saveAnalysis({ ...analysis, graph: serializeGraph(graph) });
  console.log("已回写 analysis_json（--write）");
} else {
  console.log("演练模式：未回写。确认读数后加 --write");
}
database.close();
