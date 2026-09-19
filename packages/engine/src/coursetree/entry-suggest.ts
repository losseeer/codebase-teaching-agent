import type { CourseNode, CourseTree, SuggestedEntry } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import { isTestPath } from "../depgraph/roles.js";
import { layerCacheKey } from "../lib.js";

/**
  教学模块「推荐入口」的 LLM 选择层（单轮调用，纯推荐，不改课程树结构）：
  - 输入：模块名 + 模块说明 + 课程树候选节点（含路径 / 起始行 / 摘要）
  - 输出：最多 5 个入口节点（id 必须来自候选列表，GUI 侧可回查课程树节点）
  - 任何失败（无 provider、超时、JSON 不合法）都返回空列表 —— GUI 回落到关键词分类
  - 与 refineCourseMap 共用 TUTOR_TEACHING_PROVIDER 配置（见根目录 .env.example）
  */

const MAX_ENTRIES = 5;
/** 送进 LLM 的候选上限（排序后截断；收集不设上限——524 个节点里只看前 40 是「不相关」的根源之一） */
const MAX_LLM_CANDIDATES = 15;
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

/** 送入模型的实际输入：排过序的候选 + 模块主题。候选由 `suggestModuleEntriesCached` 组装（并进缓存键）。 */
async function selectFromCandidates(input: { candidates: Candidate[]; moduleLabel: string; moduleHint: string; provider: LlmProvider }): Promise<ModuleEntrySuggestion> {
  const { candidates, moduleLabel, moduleHint, provider } = input;
  try {
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
      temperature: 0.2,
      scene: "map.entry-suggest"
    });

    return { entries: pickEntries(response.text, candidates), usage: response.usage };
  } catch (error) {
    // 静默回落会伪装成「模型判定无入口」——至少在引擎日志里显式暴露失败原因
    console.error("[entry-suggest] LLM 调用失败，返回空列表:", error instanceof Error ? error.message : error);
    return { entries: [] };
  }
}

function collectCandidates(tree: CourseTree): Candidate[] {
  const candidates: Candidate[] = [];
  const collect = (node: CourseNode): void => {
    // 测试路径不是学习入口（与结构角色同一套判定）
    if (node.anchors.length && !isTestPath(node.anchors[0].path)) {
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
  return candidates;
}

/** 模块主题词元：label 与 hint 各自整体 + 分词（≥2 字符），全小写。 */
function themeTokens(...texts: string[]): string[] {
  const tokens = new Set<string>();
  for (const text of texts) {
    const lowered = text.toLowerCase().trim();
    if (!lowered) continue;
    tokens.add(lowered);
    for (const part of lowered.split(/[\s,，、/·:：_-]+/)) if (part.length >= 2) tokens.add(part);
  }
  return [...tokens];
}

/**
  候选按模块主题排序（2026-09-18 由「树序前 40」改语义排序）：
  - 路径命中 +20、候选摘要命中 +10、**锚点文件的 L1 摘要**命中 +15——目录聚合节点的模板摘要
    （「含 N 个可分析文件」）没有信号，文件摘要才有；这也是推荐入口在业务仓不相关的主因。
  - 其他模块已推荐的路径 -50：跨模块去重，压「不同 chip 推荐重合」。
  - 零分候选排最后但保留：池子太小时 LLM 仍可从中挑选。
  */
export function rankEntryCandidates(
  candidates: Candidate[],
  tokens: string[],
  fileSummaries: Map<string, string>,
  avoidPaths: Set<string> = new Set()
): Candidate[] {
  return candidates
    .map((candidate) => {
      const path = candidate.path.toLowerCase();
      const summary = candidate.summary.toLowerCase();
      const fileSummary = (fileSummaries.get(candidate.path) ?? "").toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (path.includes(token)) score += 20;
        if (summary.includes(token)) score += 10;
        if (fileSummary.includes(token)) score += 15;
      }
      if (avoidPaths.has(candidate.path)) score -= 50;
      return { candidate, score };
    })
    .sort((left, right) => right.score - left.score || left.candidate.path.localeCompare(right.candidate.path))
    .map((item) => item.candidate)
    .slice(0, MAX_LLM_CANDIDATES);
}

/**
  入口层的输入口径版本，进缓存键。候选收集与打分规则（`collectCandidates` / `rankEntryCandidates`
  的权重、`MAX_LLM_CANDIDATES`）或 `selectFromCandidates` 里的系统提示词改了，送进模型的候选可以
  一字不变——这类失效只有版本号管得了，改它们要同步 bump。
  */
const ENTRY_INPUT_VERSION = "candidate-v1";

/** 推荐入口结果缓存：键 = 层名 + 仓库 + **本层实际输入**（模块主题 + 排好序的候选）。
    GUI 每次进入教学页都会触发该请求，实测同一输入反复计费（8 次调用 2/3 输入完全相同）。
    只缓存非空结果——空列表可能是 LLM 失败的静默回落，缓存会把失败固化。
    键里带上候选清单本身（含跨模块去重的效果），所以「输入相同 ⇒ 模型看到的问题相同 ⇒ 可直接复用」
    这一条不需要额外论证；代价是去重顺序变化会带来少量未命中。 */
const entryCache = new Map<string, { entries: SuggestedEntry[]; at: number }>();
const ENTRY_CACHE_TTL_MS = 10 * 60_000;
const ENTRY_CACHE_MAX = 100;

/** 跨模块去重的记录：repositoryId → { path → 推荐它的模块 }。
    这是行为记录不是缓存，所以按仓库而不是按内容版本存——文件一改就忘掉「别的模块推过哪些路径」
    会让重复推荐立刻回来。与 entryCache 同一份 TTL，但上限独立：常驻进程里只增不减会积累路径。 */
const recentEntryPaths = new Map<string, { paths: Map<string, string>; at: number }>();
const RECENT_ENTRY_PATHS_MAX_KEYS = 50;
const RECENT_ENTRY_PATHS_MAX_PER_KEY = 40;

/** Map 的迭代序即插入序，配合「先 delete 再 set」即为新近度，从头裁掉最旧项。 */
function trimToNewest<Key, Value>(map: Map<Key, Value>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** 清空内存态缓存与去重记录：供测试隔离回合间状态。
    换仓/卸载路径**不**调它——两者都已按 `repositoryId` 分键，跨仓库不会串味，且都有 TTL + 条数上限。 */
export function clearModuleEntryCache(): void {
  entryCache.clear();
  recentEntryPaths.clear();
}

export async function suggestModuleEntriesCached(input: { repositoryId: string; tree: CourseTree; moduleLabel: string; moduleHint: string; provider: LlmProvider; fileSummaries?: Map<string, string> }): Promise<ModuleEntrySuggestion> {
  // 跨模块去重：其他模块最近推荐过的路径在排序时降权（同模块重进不降，避免「换着花样推同一个」被矫枉过正）
  const existing = recentEntryPaths.get(input.repositoryId);
  // 过期的记录不读也不续用，直接由下面的新 Map 顶掉
  const paths = existing && Date.now() - existing.at < ENTRY_CACHE_TTL_MS ? existing.paths : new Map<string, string>();
  const avoidPaths = new Set<string>();
  for (const [path, module] of paths) if (module !== input.moduleLabel) avoidPaths.add(path);

  const candidates = rankEntryCandidates(collectCandidates(input.tree), themeTokens(input.moduleLabel, input.moduleHint), input.fileSummaries ?? new Map(), avoidPaths);
  if (!candidates.length) return { entries: [] };

  const key = layerCacheKey({
    layer: "entry-suggest",
    repositoryId: input.repositoryId,
    contractVersion: ENTRY_INPUT_VERSION,
    modelVersion: input.provider.modelVersion,
    payload: { module: { label: input.moduleLabel, hint: input.moduleHint }, candidates }
  });
  const hit = entryCache.get(key);
  if (hit && Date.now() - hit.at < ENTRY_CACHE_TTL_MS) {
    entryCache.delete(key);
    entryCache.set(key, hit); // 刷新 LRU 新近度
    return { entries: hit.entries };
  }
  const suggestion = await selectFromCandidates({ candidates, moduleLabel: input.moduleLabel, moduleHint: input.moduleHint, provider: input.provider });
  if (suggestion.entries.length) {
    for (const entry of suggestion.entries) {
      paths.delete(entry.path);
      paths.set(entry.path, input.moduleLabel); // 先删后设：刷新该路径的新近度
    }
    trimToNewest(paths, RECENT_ENTRY_PATHS_MAX_PER_KEY);
    recentEntryPaths.delete(input.repositoryId); // set 不移动已有键的位置，删后重设才刷新 key 的新近度
    recentEntryPaths.set(input.repositoryId, { paths, at: Date.now() });
    trimToNewest(recentEntryPaths, RECENT_ENTRY_PATHS_MAX_KEYS);
    entryCache.set(key, { entries: suggestion.entries, at: Date.now() });
    if (entryCache.size > ENTRY_CACHE_MAX) {
      const oldest = entryCache.keys().next().value;
      if (oldest !== undefined) entryCache.delete(oldest);
    }
  }
  return suggestion;
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
