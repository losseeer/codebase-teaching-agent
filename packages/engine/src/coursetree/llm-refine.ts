import type { CourseNode, CourseTree } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";

export interface CourseMapRefinement {
  course: CourseTree;
  usage?: LlmUsage;
}

/**
  宏观设计的 LLM 完善层（用户可见的命名/摘要质量，结构仍由静态分析锚定）：
  - 输入：启发式课程树 + 文件摘要；把 root 与深度 ≤3 的节点提纲交给 LLM
  - 覆盖预算分批自适应：每批 ≤40 个节点、最多 3 批（120 节点）；DFS 顺序在前者优先
    （root / workflows / modules / micro 概述与函数节点先入队，超预算截断发生在长尾）
  - 输出：同名节点的中文标题（≤18 字）与摘要（≤60 字）；**不改 id / anchors / 树结构**
  - 失败只损失所在批次：单批超时 / JSON 不合法跳过该批继续下一批；全部失败原样返回输入树 —— 导入永不因 LLM 失败而中断
  - 禁用「工作流 N」这类模板命名（engine 侧已改用路径命名，LLM 层进一步语义化）

  Config（见根目录 .env.example）：
  - 走 light 档（TUTOR_LIGHT_*），未配置回落主力档（TUTOR_TEACHING_*）
  */

const MAX_DEPTH = 3;
const BATCH_SIZE = 40;
const MAX_BATCHES = 3;
const MAX_TITLE = 18;
const MAX_SUMMARY = 60;
/** 每批输出预算：40 条 × (key+标题+摘要) ≈ 2800 token；推理模型的思考余量由 provider 层统一加。 */
const BATCH_MAX_TOKENS = 3_200;

interface NodeRename {
  key: string;
  title: string;
  summary: string;
}

interface OutlineEntry {
  key: string;
  kind: string;
  title: string;
  summary: string;
  anchor?: string;
  lines?: number;
}

const REFINE_SYSTEM_PROMPT = [
  "你是代码教学产品的课程编辑。给定一份由静态分析产出的课程节点提纲（含入口文件路径、摘要与节点类型），",
  `在能从提纲推断事实的前提下，尽量覆盖更多节点，重写其中文标题（≤${MAX_TITLE} 字）与摘要（≤${MAX_SUMMARY} 字）。`,
  "",
  "节点 kind 含义：overview=仓库整体定位；workflow=一条执行路径；module=职责域；implementation=函数级实现细节。",
  "",
  "标题规则：",
  "- 用文件名、真实符号名或职责语义命名，具体、避免套话；禁止「工作流 1」「模块 2」这类序号模板。",
  "- overview/workflow 用动作短语概括链路（如「从入口到路由的启动链路」）；module 用名词短语点明职责（如「配置加载与校验」）；implementation 用「函数名 + 动作」点明它做什么。",
  "- 摘要规则：只陈述能从路径、锚点与现有摘要推断的事实（做什么、被谁调用、依赖什么）；不评价代码质量、不猜测作者动机、不编造未提供的细节。",
  "- 确实无法从提纲推断的节点直接省略它的 key（输出里不出现），宁缺毋滥；不要为了覆盖全部节点而编内容。",
  "",
  "严格输出 JSON 数组：[{\"key\":\"原样返回\",\"title\":\"…\",\"summary\":\"…\"}]，不要输出任何其他文字。"
].join("\n");

export async function refineCourseMap(tree: CourseTree, provider: LlmProvider): Promise<CourseMapRefinement> {
  const outline: OutlineEntry[] = [];
  const collect = (node: CourseNode, depth: number): void => {
    if (depth > MAX_DEPTH || outline.length >= BATCH_SIZE * MAX_BATCHES) return;
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
  if (!outline.length) return { course: tree };

  const renames = new Map<string, NodeRename>();
  let usage: LlmUsage | undefined;
  const batches: OutlineEntry[][] = [];
  for (let offset = 0; offset < outline.length; offset += BATCH_SIZE) {
    batches.push(outline.slice(offset, offset + BATCH_SIZE));
  }
  for (const batch of batches.slice(0, MAX_BATCHES)) {
    try {
      const response = await provider.complete({
        system: REFINE_SYSTEM_PROMPT,
        user: JSON.stringify(batch),
        maxTokens: BATCH_MAX_TOKENS,
        temperature: 0.2,
        scene: "map.refine"
      });
      usage = addUsage(usage, response.usage);
      for (const [key, rename] of parseRenames(response.text)) renames.set(key, rename);
    } catch {
      continue; // 单批失败只丢该批，不拖垮整棵地图
    }
  }
  if (!renames.size) return { course: tree };
  return { course: { ...tree, root: applyRenames(tree.root, renames, 0) }, usage };
}

function addUsage(total: LlmUsage | undefined, addition?: LlmUsage): LlmUsage | undefined {
  if (!addition) return total;
  const sum = (a: number | undefined, b: number | undefined): number | undefined =>
    typeof a === "number" || typeof b === "number" ? (a ?? 0) + (b ?? 0) : undefined;
  if (!total) {
    return {
      inputTokens: addition.inputTokens,
      outputTokens: addition.outputTokens,
      promptCacheHitTokens: sum(undefined, addition.promptCacheHitTokens),
      promptCacheMissTokens: sum(undefined, addition.promptCacheMissTokens)
    };
  }
  return {
    inputTokens: total.inputTokens + addition.inputTokens,
    outputTokens: total.outputTokens + addition.outputTokens,
    promptCacheHitTokens: sum(total.promptCacheHitTokens, addition.promptCacheHitTokens),
    promptCacheMissTokens: sum(total.promptCacheMissTokens, addition.promptCacheMissTokens)
  };
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
  const rename = depth <= MAX_DEPTH ? renames.get(node.id) : undefined;
  return {
    ...node,
    title: rename?.title ?? node.title,
    summary: rename?.summary ?? node.summary,
    children: node.children.map((child) => applyRenames(child, renames, depth + 1))
  };
}
