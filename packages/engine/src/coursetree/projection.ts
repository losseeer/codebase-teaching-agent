import type { CourseNode, CourseNodePage, CourseTree, RepositoryIndex, RepositoryOverview } from "@codebase-tutor/shared";

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
