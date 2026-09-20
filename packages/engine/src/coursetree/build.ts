import { dirname } from "node:path";
import type { CourseNode, CourseTree, FileEntry, ImplementationUnit, QualityReport } from "@codebase-tutor/shared";
import type { DependencyGraph } from "../depgraph/graph.js";
import type { FileSummary } from "../summarizer/summarizer.js";

export function buildCourseTree(input: {
  repositoryId: string;
  modelVersion: string;
  files: FileEntry[];
  summaries: FileSummary[];
  graph: DependencyGraph;
  implementations?: ImplementationUnit[];
}): CourseTree {
  const byPath = new Map(input.summaries.map((summary) => [summary.path, summary.summary]));
  const moduleFiles = new Map<string, FileEntry[]>();
  for (const file of input.files) {
    const moduleName = dirname(file.path) === "." ? "根目录" : dirname(file.path);
    moduleFiles.set(moduleName, [...(moduleFiles.get(moduleName) ?? []), file]);
  }
  const workflows = input.graph.entrypoints.filter((anchor) => !isFixturePath(anchor.path)).map((anchor) => workflowNode(anchor, byPath, input.graph));
  const modules = [...moduleFiles.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([moduleName, files]) => ({
    id: `module:${moduleName}`,
    title: `${moduleName} 模块`,
    kind: "module" as const,
    summary: `${moduleName} 包含 ${files.length} 个可分析文件。${files.slice(0, 2).map((file) => byPath.get(file.path)).filter(Boolean).join(" ")}`,
    anchors: files.slice(0, 3).map((file) => ({ path: file.path, line: 1, label: "模块入口" })),
    children: []
  }));
  const implementations = (input.implementations ?? []).map((unit) => ({
    id: unit.id,
    title: `${unit.symbol.name}()` ,
    kind: "implementation" as const,
    summary: unit.summary,
    anchors: [{ path: unit.symbol.path, line: unit.symbol.line, endLine: unit.symbol.endLine, label: "实现定义" }],
    verification: unit.verification,
    children: []
  }));
  return {
    repositoryId: input.repositoryId,
    modelVersion: input.modelVersion,
    generatedAt: new Date().toISOString(),
    root: {
      id: "overview",
      title: "代码库全景",
      kind: "overview",
      summary: workflows.length
        ? `本课程从 ${workflows.length} 个入口和 ${modules.length} 个模块建立心智地图。先理解执行路径，再按需深入热点或模块。`
        : `本仓库未检测到可执行入口（库或工具项目的常见形态），从 ${modules.length} 个模块建立心智地图，按依赖与热度深入。`,
      anchors: workflows[0]?.anchors ?? modules[0]?.anchors ?? [],
      children: [
        { id: "workflows", title: "从入口理解执行路径", kind: "overview", summary: "从路由、CLI 和应用入口追踪主要执行路径。", anchors: [], children: workflows.length ? workflows : [noEntrypointNode()] },
        { id: "modules", title: "模块地图", kind: "overview", summary: "按目录浏览职责边界；每个节点都附有源码锚点。", anchors: [], children: modules },
        { id: "micro", title: "微观精读", kind: "overview", summary: "函数级输入、输出、不变量、边界和陷阱。", anchors: [], children: implementations }
      ]
    }
  };
}

/**
 * 微观归组投影：把函数级节点按锚点目录搬回所属模块的 children，让「树」不再是三条平行清单。
 * 必须跑在润色**之后**——润色吃的仍是平坦结构，其缓存标记与产出都不受归组影响；
 * 归组本身只改挂位置不改 id/摘要，对已归组的树重复执行是无操作（幂等）。
 */
export function groupImplementationsByModule(tree: CourseTree): CourseTree {
  const micro = tree.root.children.find((node) => node.id === "micro");
  const modules = tree.root.children.find((node) => node.id === "modules");
  if (!micro || !modules) return tree;
  const moduleIds = new Set(modules.children.map((node) => node.id));
  const moved = new Map<string, CourseNode[]>();
  const orphans: CourseNode[] = [];
  for (const implementation of micro.children) {
    const path = implementation.anchors[0]?.path;
    const dir = path ? (dirname(path) === "." ? "根目录" : dirname(path)) : undefined;
    const moduleId = dir ? `module:${dir}` : undefined;
    if (moduleId && moduleIds.has(moduleId)) {
      moved.set(moduleId, [...(moved.get(moduleId) ?? []), implementation]);
    } else {
      orphans.push(implementation);
    }
  }
  if (!moved.size) return tree; // 幂等快路径：已归组（或无可搬节点）时原样返回
  const children = tree.root.children.map((section) => {
    if (section.id === "modules") {
      return { ...section, children: section.children.map((module) => (moved.get(module.id) ? { ...module, children: [...module.children, ...moved.get(module.id)!] } : module)) };
    }
    if (section.id === "micro") {
      return { ...section, children: orphans, summary: orphans.length ? section.summary : "函数级节点已按其所在目录归入对应模块，展开模块即可查看精读清单。" };
    }
    return section;
  });
  return { ...tree, root: { ...tree.root, children } };
}

export function attachQuality(tree: CourseTree, quality: QualityReport): CourseTree {
  const checks = new Map(quality.macro.map((check) => [check.anchors[0] ? `${check.anchors[0].path}:${check.anchors[0].line}` : check.statement, check]));
  const visit = (node: CourseNode): CourseNode => {
    const anchor = node.anchors[0];
    const key = anchor ? `${anchor.path}:${anchor.line}` : node.summary;
    return { ...node, verification: node.verification?.length ? node.verification : checks.get(key) ? [checks.get(key)!] : undefined, children: node.children.map(visit) };
  };
  return { ...tree, root: visit(tree.root) };
}

/** 仓内 fixture/demo 目录不是真实的执行入口（如 test-fixtures 里的示例仓库），不作为「执行路径」的讲述对象。 */
const FIXTURE_SEGMENT = /(?:^|\/)(?:test-fixtures|fixtures?|demos?|examples?|__tests__|__mocks__|snapshots?)(?:\/|$)/i;

function isFixturePath(path: string): boolean {
  return FIXTURE_SEGMENT.test(path);
}

function workflowNode(anchor: { path: string; line: number; label: string }, summaries: Map<string, string>, graph: DependencyGraph): CourseNode {
  const dependencies = graph.imports.get(anchor.path) ?? [];
  return {
    id: `workflow:${anchor.path}`,
    title: anchor.path,
    kind: "workflow",
    summary: `${anchor.label}。${summaries.get(anchor.path) ?? ""}`,
    anchors: [anchor],
    children: dependencies.slice(0, 5).map((path) => ({
      id: `workflow:${anchor.path}->${path}`,
      title: path,
      kind: "module" as const,
      summary: summaries.get(path) ?? "该依赖尚无摘要。",
      anchors: [{ path, line: 1, label: "入口依赖" }],
      children: []
    }))
  };
}

/**
 * 未检测到入口是仓库的真实形态（库/轮子通常没有进程入口），不是解析失败：
 * 不拿首个文件伪造假入口，分区明说事实，心智地图改从模块建立。
 */
function noEntrypointNode(): CourseNode {
  return {
    id: "workflow:no-entry",
    title: "未检测到可执行入口",
    kind: "workflow",
    summary: "本仓库没有以进程入口暴露的代码，很可能是库或工具项目。先从模块地图建立心智地图，再按依赖与热度深入实现。",
    anchors: [],
    children: []
  };
}
