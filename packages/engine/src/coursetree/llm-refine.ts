import type { CourseNode, CourseTree } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";

export interface CourseMapRefinement {
  course: CourseTree;
  usage?: LlmUsage;
}

/**
  课程地图的 LLM 完善层（用户可见的命名/摘要质量，结构仍由静态分析锚定）：
  - 输入：启发式课程树 + 文件摘要；把 root 与深度 ≤2 的节点提纲交给 LLM
  - 输出：同名节点的中文标题（≤18 字）与摘要（≤60 字）；**不改 id / anchors / 树结构**
  - 任何失败（无 provider、超时、JSON 不合法）都原样返回输入树 —— 导入永不因 LLM 失败而中断
  - 禁用「工作流 N」这类模板命名（engine 侧已改用路径命名，LLM 层进一步语义化）

  Config（预留，见根目录 .env.example）：
  - TUTOR_TEACHING_PROVIDER = openai | openai-compatible | anthropic | ollama
  - OPENAI_API_KEY / TUTOR_ANTHROPIC_API_KEY / TUTOR_OLLAMA_URL 等
  */

const MAX_OUTLINE = 24;
const MAX_TITLE = 18;
const MAX_SUMMARY = 60;

interface NodeRename {
  key: string;
  title: string;
  summary: string;
}

export async function refineCourseMap(tree: CourseTree, provider: LlmProvider): Promise<CourseMapRefinement> {
  try {
    const outline: { key: string; kind: string; title: string; summary: string; anchor?: string; lines?: number }[] = [];
    const collect = (node: CourseNode, depth: number): void => {
      if (depth > 2 || outline.length >= MAX_OUTLINE) return;
      outline.push({
        key: node.id,
        kind: node.kind,
        title: node.title,
        summary: node.summary,
        anchor: node.anchors[0]?.path,
        lines: node.anchors[0]?.endLine
      });
      node.children.forEach((child) => collect(child, depth + 1));
    };
    collect(tree.root, 0);

    const system = [
      "你是代码教学产品的课程编辑。根据给定的代码库节点提纲（含入口文件路径与摘要），",
      `为每个节点写中文标题（≤${MAX_TITLE} 字，具体、避免套话）和摘要（≤${MAX_SUMMARY} 字，只陈述可从路径与摘要推断的事实）。`,
      "严格输出 JSON 数组：[{\"key\":\"原样返回\",\"title\":\"…\",\"summary\":\"…\"}]，不要输出其他文字。",
      "禁止使用「工作流 1」「模块 2」这类序号模板命名；用文件/职责语义命名。"
    ].join("");

    const response = await provider.complete({
      system,
      user: JSON.stringify(outline),
      maxTokens: 1_600,
      temperature: 0.2
    });

    const renames = parseRenames(response.text);
    if (!renames.size) return { course: tree };
    return { course: { ...tree, root: applyRenames(tree.root, renames, 0) }, usage: response.usage };
  } catch {
    return { course: tree };
  }
}

function parseRenames(text: string): Map<string, NodeRename> {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start < 0 || end <= start) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return new Map();
  }
  const renames = new Map<string, NodeRename>();
  if (!Array.isArray(parsed)) return renames;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const key = String((item as { key?: unknown }).key ?? "");
    const title = String((item as { title?: unknown }).title ?? "").trim().slice(0, MAX_TITLE);
    const summary = String((item as { summary?: unknown }).summary ?? "").trim().slice(0, MAX_SUMMARY + 20);
    if (key && title) renames.set(key, { key, title, summary });
  }
  return renames;
}

function applyRenames(node: CourseNode, renames: Map<string, NodeRename>, depth: number): CourseNode {
  const rename = depth <= 2 ? renames.get(node.id) : undefined;
  return {
    ...node,
    title: rename?.title ?? node.title,
    summary: rename?.summary ?? node.summary,
    children: node.children.map((child) => applyRenames(child, renames, depth + 1))
  };
}
