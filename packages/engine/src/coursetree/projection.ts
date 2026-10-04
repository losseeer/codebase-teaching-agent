import type { CourseNode, CourseNodePage, CourseTier, CourseTree, FileRole, RepositoryIndex, RepositoryOverview } from "@codebase-tutor/shared";

/**
  模块分级（2026-10-02 分级折叠）：给「模块地图」的每个模块节点标 `tier`，界面据此把外围折起来。
  判据是模块**可见文件**（本节点锚点 + 子孙锚点，就是用户在 chips 与推荐入口里看到的那批）的结构角色：
  有一个主干文件就算主干，只剩工具/测试才算外围。
  在响应前现算而不是写进树：角色是纯函数、每次几毫秒，且**已导入的仓库不用重烧就能看到分级**。
  */
export function annotateModuleTiers(tree: CourseTree, roles: Map<string, FileRole>): CourseTree {
  const branch = tree.root.children.find((node) => node.id === "modules");
  if (!branch) return tree;
  const tierOf = (node: CourseNode): CourseTier => {
    const seen = new Set<FileRole>();
    const collect = (current: CourseNode): void => {
      for (const anchor of current.anchors) seen.add(roles.get(anchor.path) ?? "tool");
      current.children.forEach(collect);
    };
    collect(node);
    if (seen.has("core")) return "core";
    if (seen.has("support") || seen.has("infra")) return "facility";
    return "periphery";
  };
  const children = branch.children.map((module) => ({ ...module, tier: tierOf(module) }));
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
