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
  const workflows = input.graph.entrypoints.map((anchor) => workflowNode(anchor, byPath, input.graph));
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
      summary: `本课程从 ${workflows.length || 1} 个入口和 ${modules.length} 个模块建立心智地图。先理解执行路径，再按需深入热点或模块。`,
      anchors: workflows[0]?.anchors ?? modules[0]?.anchors ?? [],
      children: [
        { id: "workflows", title: "从入口理解执行路径", kind: "overview", summary: "从路由、CLI 和应用入口追踪主要执行路径。", anchors: [], children: workflows.length ? workflows : [fallbackWorkflow(input.files, byPath)] },
        { id: "modules", title: "模块地图", kind: "overview", summary: "按目录浏览职责边界；每个节点都附有源码锚点。", anchors: [], children: modules },
        { id: "micro", title: "微观精读", kind: "overview", summary: "函数级输入、输出、不变量、边界和陷阱。", anchors: [], children: implementations }
      ]
    }
  };
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

function fallbackWorkflow(files: FileEntry[], summaries: Map<string, string>): CourseNode {
  const file = files[0];
  return {
    id: "workflow:first-file",
    title: file ? `从 ${file.path} 开始` : "仓库中没有可分析的源文件",
    kind: "workflow",
    summary: file ? summaries.get(file.path) ?? "该文件将作为课程入口。" : "请导入包含源文件的仓库。",
    anchors: file ? [{ path: file.path, line: 1, label: "可用入口" }] : [],
    children: []
  };
}
