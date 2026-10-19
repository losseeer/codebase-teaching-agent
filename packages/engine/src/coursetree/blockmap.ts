import type { CourseNode, CourseTier, CourseTree, RepositoryAnalysis, RepositoryIndex, RepositoryOverlays } from "@codebase-tutor/shared";
import { graphFromData, isServedEntrypoint } from "../depgraph/graph.js";
import { classifyFileRoles, fileStructureOf } from "../depgraph/roles.js";
import { applyRepositoryOverlays } from "../store/overlays.js";
import { annotateModuleTiers } from "./projection.js";

/**
  画布可引用的模块块，以及 `/course` 的模块视图。

  块是「原子模块经隐藏孤立节点、同父合并」后的集合，只给 agent 画图与图库现场用；
  它不再是分层产物的输入，也不读人工覆盖层——挪一个模块不该改变节点清单。
*/

/** 模块压缩流水线的三条阈值：画布里没用的模块直接删除，能合的就合，剩下的才折叠。 */
const MERGE_MAX_FILES = 2;
const MERGE_MIN_MEMBERS = 2;
const MERGE_MAX_MEMBERS = 4;
/** 父目录至少这么深才允许合并：本仓 `packages` 下十个包根并成一块是灾难，`.../src/depgraph` 的兄弟目录并起来才叫中间模块。 */
const MERGE_MIN_PARENT_DEPTH = 2;

/**
  模块 → 它可见的文件（本节点锚点 + 子孙锚点，去重）：与分级层、GUI 模块清单同一条口径。
  导出给画图工作区复用（`diagram/set-diagram.ts` 核一条边的依据用的就是这张表）——
  「这个模块包含哪些文件」只能有一套算法，否则图上两个节点说的是两回事。
*/
export function moduleFiles(node: CourseNode): string[] {
  const paths: string[] = [];
  const collect = (current: CourseNode): void => {
    current.anchors.forEach((anchor) => paths.push(anchor.path));
    current.children.forEach(collect);
  };
  collect(node);
  return [...new Set(paths)];
}

/** 课程树「模块地图」那一支的全部模块节点（与画布上 `kind:"module"` 的节点同一份 id 池）。 */
export function moduleNodes(course: CourseTree): CourseNode[] {
  const branch = course.root.children.find((node) => node.id === "modules");
  return branch?.children.filter((node) => node.kind === "module") ?? [];
}

/** 块在画布上的角色：`side` 只在判据内部出现，它不进图。 */
export type ModuleBlockRole = "entry" | "core" | "shared" | "support";

/** 模块在画布上的角色：原子模块，或同父同角色的几个小模块合起来的中间块。 */
export interface ModuleBlock {
  /** 原子块就是模块 id；组合节点是 `arch:<目录>:<角色>`——它不在课程树里，点开要靠 `members` 回到原子模块。 */
  id: string;
  title: string;
  summary: string;
  tier: CourseTier;
  files: string[];
  members: string[];
  role: ModuleBlockRole;
}

type ModuleRole = ModuleBlockRole | "side";

/**
  组合节点的标题：成员名整段拼到 24 字为止，装不下的用「等」收尾。
  不用父目录末段（末段常常只是包根名，读者看不出里面是什么），也不截半句话——
  一个节点的名字读到一半断了，比它长一点更糟。
*/
function joinedTitle(members: CourseNode[]): string {
  const parts: string[] = [];
  for (const node of members) {
    if (parts.length && parts.join("、").length + node.title.length + 1 > 24) break;
    parts.push(node.title);
  }
  return parts.length === members.length ? parts.join("、") : `${parts.join("、")} 等`;
}

/**
  画布的模块集合 = 原子模块经「隐藏孤立节点 → 同父合并」压缩后的块集合。
  孤立节点连进上下文都是多付 token，而组合节点的粒度必须先让模型看见，
  否则模型画的是一堆碎片、读者看到的是少数几个块，两套口径迟早打架。

  可达性沿 import ∪ 调用 ∪ 接口实现三条边算。最后那条不能省：Spring 的控制器只 import 接口，
  `service/impl` 与 `mapper` 在纯 import 图上永远不可达，只按 import 判就会把全仓最核心的实现当孤立节点删掉。
*/
export function moduleBlocks(course: CourseTree, analysis: RepositoryAnalysis): { blocks: ModuleBlock[]; sideModules: number } {
  const modules = moduleNodes(course);
  const filesOf = new Map(modules.map((node) => [node.id, moduleFiles(node)]));
  const servedEntryPaths = new Set((analysis.graph.entrypoints ?? []).filter(isServedEntrypoint).map((anchor) => anchor.path));
  /**
    可达性的种子用全部入口候选，不只词典认出来的服务入口：TS 侧的规则只产出「conventional entrypoint」
    （`server.ts` / `main.tsx` 这一档），只拿 served 当种子会把整个仓判成走不到、把最该看的那个节点当孤立节点删掉。
    `entry` 这一档角色仍只认 served——「含对外服务入口」这句话不能因为一个 index 文件就说出口。
   */
  const entrySeeds = new Set((analysis.graph.entrypoints ?? []).map((anchor) => anchor.path));
  const ownerOf = new Map<string, string>();
  for (const node of modules) for (const file of filesOf.get(node.id) ?? []) if (!ownerOf.has(file)) ownerOf.set(file, node.id);
  const out = new Map<string, Set<string>>();
  const inCount = new Map<string, Set<string>>();
  const link = (from: string | undefined, to: string | undefined): void => {
    if (!from || !to || from === to) return;
    if (!out.has(from)) out.set(from, new Set());
    if (!inCount.has(to)) inCount.set(to, new Set());
    out.get(from)!.add(to);
    inCount.get(to)!.add(from);
  };
  for (const [fromPath, targets] of Object.entries(analysis.graph.imports ?? {})) {
    const from = ownerOf.get(fromPath);
    if (!from) continue;
    for (const target of targets) link(from, ownerOf.get(target));
  }
  for (const call of analysis.graph.calls ?? []) link(ownerOf.get(call.callerPath), ownerOf.get(call.calleePath));
  // 接口 → 实现：运行时才接上的那条边，判「谁是主干」全靠它
  for (const edge of analysis.graph.dispatch ?? []) if (edge.kind === "implements") link(ownerOf.get(edge.supertypePath), ownerOf.get(edge.subtypePath));
  const seeds = modules.filter((node) => (filesOf.get(node.id) ?? []).some((path) => entrySeeds.has(path))).map((node) => node.id);
  const reach = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    for (const next of out.get(queue.shift()!) ?? []) if (!reach.has(next)) { reach.add(next); queue.push(next); }
  }
  /** 判据按顺序命中：入口 → 孤立节点（无入边且入口走不到）→ 底座（被 ≥4 处引用而自己最多引 3 处）→ 主干 → 支撑。 */
  const roleOf = (node: CourseNode): ModuleRole => {
    const files = filesOf.get(node.id) ?? [];
    if (files.some((path) => servedEntryPaths.has(path))) return "entry";
    if (!(inCount.get(node.id)?.size) && !reach.has(node.id)) return "side";
    if ((inCount.get(node.id)?.size ?? 0) >= 4 && (out.get(node.id)?.size ?? 0) <= 3) return "shared";
    return reach.has(node.id) ? "core" : "support";
  };
  const parentOf = (node: CourseNode): string => node.id.replace(/^module:/, "").split("/").slice(0, -1).join("/");
  const make = (id: string, members: CourseNode[], role: ModuleBlockRole): ModuleBlock => ({
    id,
    title: members.length === 1 ? members[0].title : joinedTitle(members),
    summary: members.map((node) => node.summary).join("；").slice(0, 80),
    tier: (["core", "facility", "periphery"] as CourseTier[]).find((tier) => members.some((node) => (node.tier ?? "periphery") === tier)) ?? "periphery",
    files: [...new Set(members.flatMap((node) => filesOf.get(node.id) ?? []))],
    members: members.map((node) => node.id),
    role
  });
  const kept = modules.filter((node) => roleOf(node) !== "side");
  const groups = new Map<string, CourseNode[]>();
  for (const node of kept) {
    const parent = parentOf(node);
    if (parent.split("/").filter(Boolean).length < MERGE_MIN_PARENT_DEPTH || (filesOf.get(node.id) ?? []).length > MERGE_MAX_FILES) continue;
    const key = `${parent}|${roleOf(node)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(node);
  }
  /** 够格的组才真的合并：成员数不在 2~4 之间就不合（1 个是原地踏步，5 个以上会造出一个比原子模块还难读的巨型块）。 */
  const eligible = new Map<string, { key: string; members: CourseNode[] }>();
  for (const [key, members] of groups) {
    if (members.length < MERGE_MIN_MEMBERS || members.length > MERGE_MAX_MEMBERS) continue;
    for (const node of members) eligible.set(node.id, { key, members });
  }
  // 按树里的原顺序出块（组合节点落在它第一个成员的位置），这样「前 N 个」才是稳定的
  const blocks: ModuleBlock[] = [];
  const emitted = new Set<string>();
  for (const node of kept) {
    const group = eligible.get(node.id);
    if (!group) {
      blocks.push(make(node.id, [node], roleOf(node) as ModuleBlockRole));
      continue;
    }
    if (emitted.has(group.key)) continue;
    emitted.add(group.key);
    const [parent, role] = group.key.split("|");
    // id 带角色：同一父目录下不同角色的两组若都够合并条件，不带角色就会撞出两个同名块
    blocks.push(make(`arch:${parent}:${role}`, group.members, role as ModuleBlockRole));
  }
  return { blocks, sideModules: modules.length - kept.length };
}

/**
  模块地图那条出口的共同形态：先实时计算 tier，再叠人工覆盖层。
  `/course` 与画布的模块现场都走这里，所以「界面看到的分组」与 agent 看到的模块 id 不会各算一套。
  幂等靠 id：覆盖层按模块 id 改名/隐藏/改档，叠两次还是同一份。
*/
export function moduleCourseOf(course: CourseTree, analysis: RepositoryAnalysis, index: RepositoryIndex, overlays: RepositoryOverlays): CourseTree {
  const roles = classifyFileRoles(fileStructureOf(index.files, graphFromData(analysis.graph)));
  return applyRepositoryOverlays(annotateModuleTiers(course, roles, analysis.graph.entrypoints), overlays);
}
