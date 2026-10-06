/**
  零 token、只读：把「主干 / 设施 / 外围 分不准」拆成可数的成因，并量每种改法的改写量。
  DB 以 readOnly 打开，不写任何产物。用法：pnpm tier:diag /absolute/path/to/repository
*/
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CourseTier, CourseTree, FileRole, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import { LANGUAGE_BY_EXTENSION } from "@codebase-tutor/shared";
import { graphFromData } from "../depgraph/graph.js";
import { buildFileEdges, classifyFileRoles, fileStructureOf, infraHintOf, INFRA_HINTS, isTestPath } from "../depgraph/roles.js";
import { annotateModuleTiers } from "../coursetree/projection.js";

const repositoryPath = resolve(process.argv[2] ?? "");
if (!repositoryPath) throw new Error("Usage: pnpm tier:diag /absolute/path/to/repository");

const db = new DatabaseSync(join(repositoryPath, ".tutor", "tutor.db"), { readOnly: true });
const state = db.prepare("SELECT repository_id, index_json, course_json, analysis_json FROM repository_state WHERE course_json IS NOT NULL LIMIT 1").get() as
  | { repository_id: string; index_json: string; course_json: string; analysis_json: string } | undefined;
if (!state) throw new Error("仓库没有课程树产物：先导入。");
const cacheRows = db.prepare("SELECT cache_key, payload FROM layer_cache").all() as { cache_key: string; payload: string }[];
const cachedSummaries = (db.prepare("SELECT COUNT(*) AS n FROM summaries").get() as { n: number }).n;
db.close();
/** 每条缓存流程引用到的文件集合：角色一改，引用了它的流程就翻键——这是改判据的真实代价。 */
const flowPathSets = cacheRows.filter((row) => row.cache_key.startsWith("flow:")).map((row) =>
  new Set([...row.payload.matchAll(/"path":"([^"]+)"/g)].map((match) => match[1])));

const index = JSON.parse(state.index_json) as RepositoryIndex;
const analysis = JSON.parse(state.analysis_json) as RepositoryAnalysis;
const tree = JSON.parse(state.course_json) as CourseTree;
const graph = graphFromData(analysis.graph);
const structure = fileStructureOf(index.files, graph);
const { dependencies, dependents } = buildFileEdges(structure);
const roles = classifyFileRoles(structure);

const entryPaths = new Set(structure.entrypoints.map((anchor) => anchor.path));

/** 离最近入口几跳（沿「本文件依赖谁」往下走，类型派发**透明**：接口→实现算同一拍）；未收录 = 任何入口都到不了。 */
const hop = new Map<string, number>();
{
  const dispatches = new Map<string, Set<string>>();
  for (const edge of graph.dispatch ?? []) {
    const set = dispatches.get(edge.supertypePath) ?? new Set<string>();
    set.add(edge.subtypePath);
    dispatches.set(edge.supertypePath, set);
  }
  const queue: string[] = [...entryPaths];
  for (const path of queue) hop.set(path, 0);
  const visit = (path: string, depth: number): void => {
    if (hop.has(path)) return;
    hop.set(path, depth);
    queue.push(path);
    // 派发透传：实现类与接口同跳，但它下面的文件仍算下一跳
    for (const subtype of dispatches.get(path) ?? []) if (!hop.has(subtype)) { hop.set(subtype, depth); queue.push(subtype); }
  };
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const here = queue[cursor];
    const next = (hop.get(here) ?? 0) + 1;
    for (const target of dependencies.get(here) ?? []) visit(target, next);
  }
}

/**
  旧判据的原样复刻（只有这里允许两份实现：它是「被替换前的那把尺子」，不该进生产代码）。
  生产判据现已改成「文件名成词命中 + 业务同形词黑名单」，留着它只为把「挡掉了多少」数出来。
*/
function legacyInfraHit(path: string): string | undefined {
  const lower = path.toLowerCase();
  return INFRA_HINTS.find((candidate) => lower.includes(candidate));
}

/** 与生产判据同一把尺子（`roles.ts` 导出的 `infraHintOf`），脚本里绝不另判一套。 */
const infraHit = infraHintOf;

const files = index.files.map((file) => file.path);
/** 「源码文件」= 扩展名在语言表里有归属的那些；文档 / 看板 / 编排文件也会出现在流程证据里，但它们是名副其实的外围。 */
const sourceExtensions = new Set(Object.keys(LANGUAGE_BY_EXTENSION));
const extensionOf = new Map(index.files.map((file) => [file.path, file.extension.toLowerCase()]));
const isolated = files.filter((path) => !dependencies.get(path)?.size && !dependents.get(path)?.size);
const pathsInFlows = new Set<string>(flowPathSets.flatMap((set) => [...set]));

const layerTally = new Map<string, number>();
for (const row of cacheRows) {
  const layer = row.cache_key.split(":")[0] ?? "?";
  layerTally.set(layer, (layerTally.get(layer) ?? 0) + 1);
}
console.log(`仓库 ${state.repository_id} ｜ 文件 ${files.length} ｜ 入口 ${entryPaths.size} ｜ 存量摘要 ${cachedSummaries} 行 ｜ L2 缓存 ${[...layerTally.entries()].sort().map(([key, count]) => `${key}=${count}`).join(" ")}`);

const dist = (values: Iterable<string>): string => {
  const tally = new Map<string, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  return [...tally.entries()].sort().map(([key, count]) => `${key}=${count}`).join("  ");
};
console.log(`\n[1] 角色分布 ${dist(roles.values())}`);
const tiers = annotateModuleTiers(tree, roles, structure.entrypoints).root.children.find((node) => node.id === "modules")?.children ?? [];
console.log(`[2] 模块分级 ${dist(tiers.map((node) => node.tier ?? "?"))}`);

const infraByKeyword = files.filter((path) => roles.get(path) === "infra");
const orderCasualty = infraByKeyword.filter((path) => (hop.get(path) ?? Infinity) === 1);
const blockedByNewRule = files.filter((path) => legacyInfraHit(path) !== undefined && !infraHit(path).hint);
console.log(`\n[3] 成因拆解`);
console.log(`  a) 设施词抢在「入口一跳」前面就把业务文件判成设施：${orderCasualty.length}/${infraByKeyword.length}`);
for (const path of orderCasualty.slice(0, 6)) console.log(`       ${path}（命中 ${infraHit(path).hint}）`);
console.log(`  b) 旧子串判据会命中、现判据已挡掉的文件：${blockedByNewRule.length}`);
for (const path of blockedByNewRule.slice(0, 6)) console.log(`       ${path}｜旧命中 ${legacyInfraHit(path)}｜文件名词元 ${infraHit(path).tokens.join(",")}`);
const hitTokens = new Map<string, number>();
for (const path of infraByKeyword) {
  const hit = infraHit(path);
  const hint = hit.hint;
  if (!hint) continue;
  const token = hit.tokens.find((candidate) => candidate.startsWith(hint)) ?? hint;
  hitTokens.set(token, (hitTokens.get(token) ?? 0) + 1);
}
console.log(`     现判据的命中词元（逐个人工过一遍，业务第二义在这里现形：log=日志/流水、store=存储/门店）：${[...hitTokens.entries()].sort((a, b) => b[1] - a[1]).map(([token, count]) => `${token}×${count}`).join(" ")}`);
const isolatedInFlow = isolated.filter((path) => pathsInFlows.has(path));
console.log(`  c) 零边判成末端工具、但真出现在缓存流程证据里：${isolatedInFlow.length}/${isolated.length}`);
for (const path of isolatedInFlow.slice(0, 6)) console.log(`       ${path}｜角色 ${roles.get(path)}｜入口吗 ${entryPaths.has(path)}`);
const deep = files.filter((path) => (hop.get(path) ?? 0) >= 2 && (roles.get(path) === "support" || roles.get(path) === "infra"));
console.log(`  d) 入口可达但要走 ≥2 跳，只能落「支撑逻辑/设施」：${deep.length}`);
const unreachable = files.filter((path) => !isTestPath(path) && !entryPaths.has(path) && !hop.has(path));
const unreachableSource = unreachable.filter((path) => sourceExtensions.has(extensionOf.get(path) ?? ""));
const impls = files.filter((path) => /ServiceImpl|Controller|Mapper\b|Repository\b/.test(path));
console.log(`  e) 任何入口都到不了：${unreachable.length}（其中源码 ${unreachableSource.length}，文档/看板/编排 ${unreachable.length - unreachableSource.length}）`);
for (const path of unreachableSource.slice(0, 8)) console.log(`       ${path}｜出边 ${dependencies.get(path)?.size ?? 0} 入边 ${dependents.get(path)?.size ?? 0}｜角色 ${roles.get(path)}`);
console.log(`     典型分层（Controller/Service/Mapper 共 ${impls.length} 个）里入口到不了的：${impls.filter((path) => !hop.has(path)).length}`);

/** 反事实：只换判据，其余不动。改写量 = 角色变动的文件数（角色进 L1 切片键，所以它就是重烧条数）。 */
/** 词边界判据已经在生产里生效了，这一格改成反向量：回滚成旧子串判据会多判多少（改动价值的读数）。 */
const legacyRollback = (path: string): FileRole | undefined => (roles.get(path) !== "infra" && roles.get(path) !== "test" && legacyInfraHit(path) ? "infra" : undefined);
const reachFirst = (path: string): FileRole | undefined => ((hop.get(path) ?? Infinity) === 1 && roles.get(path) === "infra" ? "core" : undefined);
const twoHopCore = (path: string): FileRole | undefined => ((hop.get(path) ?? Infinity) === 2 && (roles.get(path) === "support" || roles.get(path) === "infra") ? "core" : undefined);
const variants: Record<string, (path: string) => FileRole | undefined> = {
  "G1 回滚成旧子串判据（量今天这一改的价值）": legacyRollback,
  "F2 入口可达优先（判据换序）": reachFirst,
  "F3 主干放宽到两跳": twoHopCore,
  "F4 流程证据算主干（仅源码文件）": (path) => (pathsInFlows.has(path) && sourceExtensions.has(extensionOf.get(path) ?? "") && (roles.get(path) === "support" || roles.get(path) === "tool" || roles.get(path) === "infra") && !isTestPath(path) ? "core" : undefined)
};
const baseline = new Map(tiers.map((node) => [node.id, node.tier ?? "?"]));
console.log(`\n[4] 反事实改法（改角色=翻 L1 摘要键=重烧；只改 tier 聚合=零成本）`);
for (const [name, rule] of Object.entries(variants)) {
  const patched = new Map(roles);
  const changed = new Set<string>();
  for (const path of files) {
    const next = rule(path);
    if (next && next !== roles.get(path)) { patched.set(path, next); changed.add(path); }
  }
  const after = annotateModuleTiers(tree, patched, structure.entrypoints).root.children.find((node) => node.id === "modules")?.children ?? [];
  const flips = after.filter((node) => (node.tier ?? "?") !== baseline.get(node.id));
  const staleFlows = flowPathSets.filter((set) => [...set].some((path) => changed.has(path))).length;
  console.log(`  ${name}：角色改写 ${changed.size} 个文件（=重烧 ${changed.size} 条 L1 摘要 + ${staleFlows}/${flowPathSets.length} 条缓存流程）→ 模块换档 ${flips.length}/${tiers.length}${flips.length ? `（${flips.slice(0, 4).map((node) => `${node.title}:${baseline.get(node.id)}→${node.tier}`).join("、")}）` : ""}`);
}
const visibleOf = (node: (typeof tiers)[number]): string[] => {
  const paths: string[] = [];
  const collect = (current: typeof node): void => { paths.push(...current.anchors.map((anchor) => anchor.path)); current.children.forEach(collect); };
  collect(node);
  return paths;
};
const fragile = tiers.filter((node) => node.tier === "core" && visibleOf(node).filter((path) => roles.get(path) === "core").length === 1);
console.log(`\n[5] 单文件定档（整档「主干」只靠一个 core 文件撑着）：${fragile.length} 个模块`);
for (const node of fragile.slice(0, 5)) console.log(`       ${node.title}（可见文件 ${visibleOf(node).length} 个）`);

/** 根因侧：入口到不了的那批，有多少只是因为「接口与实现之间没有边」——名字能对上就说明补这一类边就能救。 */
const byBase = new Map(files.map((path) => [path.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase(), path]));
const rescuedByImplements = unreachableSource.filter((path) => {
  const base = path.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();
  const interfaces = base.endsWith("impl") ? [base.slice(0, -4), `i${base.slice(0, -4)}`] : [base.replace(/service$/, "service"), `i${base.replace(/service$/, "service")}`];
  return interfaces.some((candidate) => {
    const match = byBase.get(candidate);
    return match !== undefined && match !== path && hop.has(match);
  });
});
console.log(`\n[6] 入口到不了的源码 ${unreachableSource.length} 个里，接口名能对上（补 implements/DI 边就能救）：${rescuedByImplements.length}`);
for (const path of rescuedByImplements.slice(0, 6)) console.log(`       ${path}`);

/** 零成本那一格：不动角色，只改「模块 → 档」的聚合判据（`annotateModuleTiers` 是响应期现算，不进任何缓存键）。 */
const tierOnly = (label: string, decide: (node: (typeof tiers)[number], current: CourseTier | undefined) => CourseTier | undefined): void => {
  const flips = tiers.map((node) => ({ node, next: decide(node, baseline.get(node.id) === "?" ? undefined : (baseline.get(node.id) as CourseTier)) }))
    .filter((entry) => entry.next && entry.next !== baseline.get(entry.node.id));
  console.log(`  ${label}：模块换档 ${flips.length}/${tiers.length}${flips.length ? `（${flips.slice(0, 4).map((entry) => `${entry.node.title}:${baseline.get(entry.node.id)}→${entry.next}`).join("、")}）` : ""}`);
};
console.log(`\n[7] 只改分级聚合（零成本、当场生效、不翻任何缓存键）`);
tierOnly("T1 模块含入口文件即算主干", (node) => (visibleOf(node).some((path) => entryPaths.has(path)) ? "core" : undefined));
tierOnly("T2 主干判据从「有 1 个 core」改成「core 占比 ≥1/4」", (node) => {
  const visible = visibleOf(node);
  const ratio = visible.length ? visible.filter((path) => roles.get(path) === "core").length / visible.length : 0;
  return ratio < 0.25 && node.tier === "core" ? "facility" : undefined;
});
console.log(`\n读法：a/b/d 是判据问题（改角色=重烧），e 是图的问题（边不全时任何判据都白搭），c 说明流程证据能反过来校准结构判据，[7] 是免费的那一格。`);
