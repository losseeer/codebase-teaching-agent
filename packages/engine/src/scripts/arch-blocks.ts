/**
  零 token、只读：数「压缩流水线在三份真仓上把多少格压掉了」，并当场检查现存人工修正的落点。
  DB 以 readOnly 打开，不写任何产物。用法：pnpm arch:blocks /absolute/path/to/repository
  存在的理由：判层单位从原子模块换成节点会翻缓存键（= 每仓要重问一发），这代价必须先数清楚再动手；
  而「每层默认显示 6 个节点」这条兜底到底还开不开得着，也只有真仓能答。
*/
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CourseNode, CourseTree, RepositoryAnalysis, RepositoryIndex, RepositoryOverlays } from "@codebase-tutor/shared";
import { architectureBlocks, moduleCourseOf } from "../coursetree/architecture.js";

const repositoryPath = resolve(process.argv[2] ?? "");
if (!repositoryPath) throw new Error("Usage: pnpm arch:blocks /absolute/path/to/repository");

const db = new DatabaseSync(join(repositoryPath, ".tutor", "tutor.db"), { readOnly: true });
const state = db.prepare("SELECT repository_id, index_json, course_json, analysis_json, settings_json FROM repository_state WHERE course_json IS NOT NULL LIMIT 1").get() as
  | { repository_id: string; index_json: string; course_json: string; analysis_json: string; settings_json: string | null } | undefined;
const cached = db.prepare("SELECT COUNT(*) AS n FROM layer_cache WHERE cache_key LIKE 'architecture:%'").get() as { n: number };
db.close();
if (!state) throw new Error("仓库没有课程树产物：先导入。");

const index = JSON.parse(state.index_json) as RepositoryIndex;
const analysis = JSON.parse(state.analysis_json) as RepositoryAnalysis;
const tree = JSON.parse(state.course_json) as CourseTree;
const overlays = (state.settings_json ? (JSON.parse(state.settings_json).overlays ?? {}) : {}) as RepositoryOverlays;

const course = moduleCourseOf(tree, analysis, index, overlays);
const modules = course.root.children.find((node) => node.id === "modules")?.children.filter((node) => node.kind === "module") ?? [];
const { blocks, sideModules } = architectureBlocks(course, analysis);

const dist = (values: Iterable<string>): string => {
  const tally = new Map<string, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key}=${count}`).join("  ");
};
const mergedBlocks = blocks.filter((block) => block.members.length > 1);
const visibleOf = (node: CourseNode): string[] => {
  const paths: string[] = [];
  const walk = (current: CourseNode): void => {
    current.anchors.forEach((anchor) => paths.push(anchor.path));
    current.children.forEach(walk);
  };
  walk(node);
  return [...new Set(paths)];
};
const entryPaths = new Set((analysis.graph.entrypoints ?? []).map((anchor) => anchor.path));
const keptIds = new Set(blocks.flatMap((block) => block.members));
const hidden = modules.filter((node) => !keptIds.has(node.id));
const hiddenWithEntry = hidden.filter((node) => visibleOf(node).some((path) => entryPaths.has(path)));
const staticLayers = (["core", "facility", "periphery"] as const).map((tier) => ({ tier, blocks: blocks.filter((block) => block.tier === tier) })).filter((layer) => layer.blocks.length);

console.log(`仓库 ${state.repository_id}｜原子模块 ${modules.length} → 节点 ${blocks.length}（隐藏孤立节点 ${sideModules}、合并吃掉 ${mergedBlocks.reduce((sum, block) => sum + block.members.length - 1, 0)} 个节点）`);
console.log(`  节点角色 ${dist(blocks.map((block) => block.role))}`);
console.log(`  隐藏这次改动有红线：被藏却含入口文件的模块 ${hiddenWithEntry.length} 个${hiddenWithEntry.length ? `（**判据错了**：${hiddenWithEntry.slice(0, 4).map((node) => node.title).join(" / ")}）` : ""}`);
console.log(`  被藏的模块（前 6 个）${hidden.slice(0, 6).map((node) => `${node.title}(${visibleOf(node).length} 文件)`).join(" / ") || "无"}`);
console.log(`  静态三层每层节点数 ${staticLayers.map((layer) => `${layer.tier}=${layer.blocks.length}`).join(" ")}｜超过 6 个节点的层 ${staticLayers.filter((layer) => layer.blocks.length > 6).length} 个（兜底折叠开不开得着就看这个节点）`);
console.log(`  架构缓存行 ${cached.n} 条（arch-v2 换了键，这些旧行不再被读；要恢复模型分层每仓点一次「重新生成分层」）`);
if (mergedBlocks.length) {
  console.log(`\n[组合节点样本]`);
  for (const block of mergedBlocks.slice(0, 8)) console.log(`  ${block.id}｜「${block.title}」成员 ${block.members.length}｜${block.members.slice(0, 3).join(" , ")}`);
}
const moved = Object.keys(overlays.architecture?.moduleLayer ?? {});
if (moved.length) {
  console.log(`\n[现存人工修正的落点]（读侧按成员拆块，不因为合过就挪不动）`);
  for (const moduleId of moved) {
    const host = blocks.find((block) => block.members.length > 1 && block.members.includes(moduleId));
    console.log(`  ${moduleId} → ${overlays.architecture?.moduleLayer?.[moduleId]}｜${host ? `会拆开创块 ${host.id}` : blocks.some((block) => block.id === moduleId) ? "本身就是节点，整块走" : "图上查不到（该报进 lostOverrides）"}`);
  }
}
