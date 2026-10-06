import type { CourseNode, CourseNodePage, CourseTier, CourseTierEvidence, CourseTree, FileRole, RepositoryIndex, RepositoryOverview, SourceAnchor } from "@codebase-tutor/shared";
import { isServedEntrypoint } from "../depgraph/graph.js";

/**
  模块分级（2026-10-02 分级折叠；2026-10-06 改成占比判据 + 把依据露出来）。
  判据是模块**可见文件**（本节点锚点 + 子孙锚点，就是用户在 chips 与推荐入口里看到的那批）的结构角色：
  含**对外服务入口**（HTTP 路由 / 框架启动类），或主干文件占到可见文件的 1/4，才算主干；只剩工具/测试才算外围。
  为什么要占比：旧判据「有一个主干文件就算主干」在 Xingyan 让一个 66 个可见文件的模块全靠 1 个文件撑成主干，
  三档的比例就读不出模块大小了（2026-10-06 tier:diag 实测该仓有 7 个模块因此虚高）。
  为什么脚本型入口既不能顶模块、也不计入主干证据：`observability/check-queries.py`（Grafana 自动加载用的运维脚本）
  与造数脚本在角色表里因为是入口所以是 core，但分级问的是「学习者该先看它吗」。
  这一格差异只在分级层处理，**不动 `classifyFileRoles`**——动角色会翻全仓摘要键（开发日志 §34.5）。
  在响应前现算而不是写进树：角色是纯函数、每次几毫秒，且**已导入的仓库不用重烧就能看到分级**。
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
      ⚠️ 这里**刻意不用** `roles.ts` 的 `roleOf()`（查不到路径回落 `support`）：
      分级问的是「这个模块有没有代码证据」，一个不在图里的路径不该被抬进「设施」。
      2026-10-06 有独立复审把它当成「同一件事两套判据」报了出来，结论是不统一——
      两处回答的是两个问题（`roleOf` 服务模型证据，`tier` 服务折叠与占比），各自说清回落理由即可。
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
    const reason = hasEntry
      ? `含 ${entryFiles.length} 个对外服务入口（HTTP 路由 / 框架启动）`
      : tier === "core"
        ? `${trunkFiles.length}/${visible.length} 个可见文件是执行主干`
        : tier === "facility"
          ? `主干只 ${trunkFiles.length}/${visible.length} 个，够不上 1/4，只剩支撑与设施`
          : "可见文件只剩末端工具与测试";
    return { tier, evidence: { visibleFiles: visible.length, coreFiles: trunkFiles.length, entryFiles: entryFiles.length, coreShare: Number(coreShare.toFixed(4)), decidingPath: trunkFiles[0], reason } };
  };
  const children = branch.children.map((module) => {
    const { tier, evidence } = grade(module);
    return { ...module, tier, tierEvidence: evidence };
  });
  return { ...tree, root: { ...tree.root, children: tree.root.children.map((node) => (node === branch ? { ...branch, children } : node)) } };
}

export function courseOverview(tree: CourseTree, index: RepositoryIndex): RepositoryOverview {
  return {
    repositoryId: tree.repositoryId,
    totalFiles: index.totalFiles,
    totalLines: index.totalLines,
    hotspots: index.hotspots.slice(0, 10),
    root: projectNode(tree.root, 1)
  };
}

export function courseChildren(tree: CourseTree, parentId: string, offset = 0, limit = 30): CourseNodePage | undefined {
  const parent = findCourseNode(tree.root, parentId);
  if (!parent) return undefined;
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const size = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 30;
  const items = parent.children.slice(start, start + size).map((node) => projectNode(node, 0));
  const nextOffset = start + items.length < parent.children.length ? start + items.length : undefined;
  return { parentId, offset: start, total: parent.children.length, items, nextOffset };
}

export function findCourseNode(root: CourseNode, nodeId: string): CourseNode | undefined {
  if (root.id === nodeId) return root;
  for (const child of root.children) {
    const match = findCourseNode(child, nodeId);
    if (match) return match;
  }
  return undefined;
}

function projectNode(node: CourseNode, depth: number): CourseNode {
  return {
    ...node,
    childCount: node.children.length,
    children: depth > 0 ? node.children.map((child) => projectNode(child, depth - 1)) : []
  };
}
