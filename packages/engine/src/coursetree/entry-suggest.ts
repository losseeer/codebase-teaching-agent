import type { CourseNode, CourseTree, SuggestedEntry } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";

/**
  教学模块「推荐入口」的 LLM 选择层（单轮调用，纯推荐，不改课程树结构）：
  - 输入：模块名 + 模块说明 + 课程树候选节点（含路径 / 起始行 / 摘要）
  - 输出：最多 5 个入口节点（id 必须来自候选列表，GUI 侧可回查课程树节点）
  - 任何失败（无 provider、超时、JSON 不合法）都返回空列表 —— GUI 回落到关键词分类
  - 与 refineCourseMap 共用 TUTOR_TEACHING_PROVIDER 配置（见根目录 .env.example）
  */

const MAX_ENTRIES = 5;
const MAX_CANDIDATES = 40;
const MAX_SUMMARY = 60;

export interface ModuleEntrySuggestion {
  entries: SuggestedEntry[];
  usage?: LlmUsage;
}

interface Candidate {
  id: string;
  title: string;
  path: string;
  line: number;
  summary: string;
}

export async function suggestModuleEntries(
  tree: CourseTree,
  moduleLabel: string,
  moduleHint: string,
  provider: LlmProvider
): Promise<ModuleEntrySuggestion> {
  try {
    const candidates: Candidate[] = [];
    const collect = (node: CourseNode): void => {
      if (candidates.length >= MAX_CANDIDATES) return;
      if (node.anchors.length) {
        candidates.push({
          id: node.id,
          title: node.title,
          path: node.anchors[0].path,
          line: node.anchors[0].line,
          summary: node.summary.slice(0, MAX_SUMMARY)
        });
      }
      node.children.forEach(collect);
    };
    collect(tree.root);
    if (!candidates.length) return { entries: [] };

    const system = [
      "你是代码教学产品的课程导览。给定一个学习模块的主题与候选代码节点列表（含文件路径、起始行与摘要），",
      `选出最适合作为该模块「推荐入口」的节点（最多 ${MAX_ENTRIES} 个）：优先选择能代表该主题的入口或主干实现，`,
      "不要选测试文件或琐碎工具函数。",
      "严格输出 JSON 数组：[{\"id\":\"候选 id 原样返回\",\"reason\":\"不超过 20 字的推荐理由\"}]，按推荐顺序排列，不要输出其他文字。"
    ].join("");

    const response = await provider.complete({
      system,
      user: JSON.stringify({ module: { label: moduleLabel, hint: moduleHint }, candidates }),
      maxTokens: 800,
      temperature: 0.2
    });

    return { entries: pickEntries(response.text, candidates), usage: response.usage };
  } catch {
    return { entries: [] };
  }
}

function pickEntries(text: string, candidates: Candidate[]): SuggestedEntry[] {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const entries: SuggestedEntry[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object" || entries.length >= MAX_ENTRIES) continue;
    const id = String((item as { id?: unknown }).id ?? "");
    const candidate = byId.get(id);
    if (!candidate || seen.has(id)) continue;
    seen.add(id);
    const reason = String((item as { reason?: unknown }).reason ?? "").trim().slice(0, 40);
    entries.push({ id: candidate.id, title: candidate.title, path: candidate.path, line: candidate.line, ...(reason ? { reason } : {}) });
  }
  return entries;
}
