import type { CourseNode, CourseTier, CourseTierEvidence, CourseTree, FileRole, SourceAnchor } from "@codebase-tutor/shared";
import { isServedEntrypoint } from "../depgraph/graph.js";

/**
  模块分级：判据是模块可见文件（本节点锚点 + 子孙锚点，即用户在 chips 与推荐入口里看到的那批）的结构角色。
  含对外服务入口（HTTP 路由 / 框架启动类），或主链路文件占到可见文件的 1/4，才算主链路；只剩工具/测试才算外围。
  用占比而不是「有一个主链路文件就算」：否则大模块靠 1 个文件就被抬成主链路，三档比例读不出模块大小。
  脚本型入口（运维/造数脚本）既不能顶模块、也不计入主链路证据：角色表里它是 core，分级问的是「学习者该先看它吗」。
  这个差异只在分级层处理，不动 `classifyFileRoles`——改角色会翻全仓摘要键。
  在响应前实时计算而不是写进树：角色是纯函数、每次几毫秒，已导入的仓库无需重新分析就能看到分级。
*/
const CORE_SHARE_THRESHOLD = 0.25;

export function annotateModuleTiers(tree: CourseTree, roles: Map<string, FileRole>, entrypoints?: readonly SourceAnchor[]): CourseTree {
  const branch = tree.root.children.find((node) => node.id === "modules");
  if (!branch) return tree;
  const served = new Set((entrypoints ?? []).filter(isServedEntrypoint).map((anchor) => anchor.path));
  const scriptOnly = new Set((entrypoints ?? []).filter((anchor) => !isServedEntrypoint(anchor)).map((anchor) => anchor.path));
  const grade = (node: CourseNode): { tier: CourseTier; evidence: CourseTierEvidence } => {
    const paths: string[] = [];
    const collect = (current: CourseNode): void => {
      current.anchors.forEach((anchor) => paths.push(anchor.path));
      current.children.forEach(collect);
    };
    collect(node);
    const visible = [...new Set(paths)];
    /**
      刻意不用 `roles.ts` 的 `roleOf()`（查不到路径回落 `support`）：分级问的是「这个模块有没有代码证据」，
      不在图里的路径不该被抬进「基础设施」。`roleOf` 服务模型证据、`tier` 服务折叠与占比，是两个问题，判据不合并。
    */
    const known = visible.map((path) => roles.get(path));
    const trunkFiles = visible.filter((path, index) => known[index] === "core" && !scriptOnly.has(path));
    const entryFiles = visible.filter((path) => served.has(path));
    const coreShare = visible.length ? trunkFiles.length / visible.length : 0;
    const hasEntry = entryFiles.length > 0;
    const tier: CourseTier = hasEntry || coreShare >= CORE_SHARE_THRESHOLD
      ? "core"
      : known.some((role) => role === "support" || role === "infra")
        ? "facility"
        : "periphery";
    /** 判据一句话：界面上它前面还会拼上档位名（「主链路：…」），所以这里不再重复档名，只给数与理由。 */
    const reason = hasEntry
      ? `含 ${entryFiles.length} 个对外服务入口`
      : tier === "core"
        ? `${trunkFiles.length}/${visible.length} 个文件是主链路`
        : tier === "facility"
          ? `主链路 ${trunkFiles.length}/${visible.length}，不到 1/4`
          : "只剩末端工具与测试";
    return { tier, evidence: { visibleFiles: visible.length, coreFiles: trunkFiles.length, entryFiles: entryFiles.length, coreShare: Number(coreShare.toFixed(4)), decidingPath: trunkFiles[0], reason } };
  };
  const children = branch.children.map((module) => {
    const { tier, evidence } = grade(module);
    return { ...module, tier, tierEvidence: evidence };
  });
  return { ...tree, root: { ...tree.root, children: tree.root.children.map((node) => (node === branch ? { ...branch, children } : node)) } };
}

export function findCourseNode(root: CourseNode, nodeId: string): CourseNode | undefined {
  if (root.id === nodeId) return root;
  for (const child of root.children) {
    const match = findCourseNode(child, nodeId);
    if (match) return match;
  }
  return undefined;
}

/** 整棵树摊平成一维清单：按 kind 筛（路由要 workflow 节点、质检要非 implementation 节点）与「按 id 找」之外的一切遍历。 */
export function flattenCourseTree(root: CourseNode): CourseNode[] {
  return [root, ...root.children.flatMap(flattenCourseTree)];
}
