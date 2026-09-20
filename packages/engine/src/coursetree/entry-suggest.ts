import type { CourseNode, CourseTree, SuggestedEntry } from "@codebase-tutor/shared";
import type { LlmProvider, LlmUsage } from "../llm/provider.js";
import type { TutorDatabase } from "../store/database.js";
import { isTestPath } from "../depgraph/roles.js";
import { layerCacheKey } from "../lib.js";

/**
  教学模块「推荐入口」的 LLM 选择层（纯推荐，不改课程树结构）。两段调用：
  - 主题翻译层（P1，2026-09-20）：中文模块主题 → 本仓库里对应的英文检索词（路径段/标识符），
    一次性、按主题+仓库指纹缓存——真仓实测证明中文概念词对英文业务仓的词法命中≈0（诊断见开发日志 §7.4）。
  - 选择层：模块主题 + 词元排序后的候选（含翻译词元）→ 最多 5 个入口；候选都不合适时允许输出空数组（P4）。
  - 失败处理：翻译失败退化为「只有原始词元」；选择层任何失败（无 provider、超时、JSON 不合法）都返回空列表
    ——但「模型主动判空」（declined）是可信答案，与失败回落区分，可以进缓存。
  - 与 refineCourseMap 共用 TUTOR_TEACHING_PROVIDER 配置（见根目录 .env.example）
  */

const MAX_ENTRIES = 5;
/** 送进 LLM 的候选上限（排序后截断；收集不设上限——524 个节点里只看前 40 是「不相关」的根源之一） */
const MAX_LLM_CANDIDATES = 15;
const MAX_SUMMARY = 60;
/** 主题翻译层产出的检索词上限：再多也只是给词法打分灌噪声。 */
const MAX_EXPANDED_TOKENS = 24;
/** 零分候选补位用的图信号路径上限（入口点 + git 热点，由 server 侧组装）。 */
const MAX_BOOST_PATHS = 20;

export interface ModuleEntrySuggestion {
  entries: SuggestedEntry[];
  usage?: LlmUsage;
  /** LLM 成功解析且明确返回空数组：模型判断池子里没有合格入口。与「调用失败的静默空」不同，可信、可缓存。 */
  declined?: boolean;
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
      "候选列表可能整体与主题无关（排序只是关键词级别的近似）；如果没有任何候选真正适合作为该模块入口，输出空数组 []，不要硬凑。",
      "严格输出 JSON 数组：[{\"id\":\"候选 id 原样返回\",\"reason\":\"不超过 20 字的推荐理由\"}]，按推荐顺序排列，不要输出其他文字。"
    ].join("");

    const response = await provider.complete({
      system,
      user: JSON.stringify({ module: { label: moduleLabel, hint: moduleHint }, candidates }),
      maxTokens: 800,
      temperature: 0.2,
      scene: "map.entry-suggest"
    });

    const picked = pickEntries(response.text, candidates);
    return { entries: picked.entries, declined: picked.declined, usage: response.usage };
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

/** 把任意文本切成「词」：非字母数字断开 + camelCase 边界（IOService → io/service 归一为整词）。 */
function wordsOf(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
  词元命中判定（P2，2026-09-20）。真仓实测：`includes` 子串匹配下 `"io"` 命中一切
  `Configur-at-ion`/`Except-ion`，102 个假阳性淹没整个「操作系统」候选池。
  - 中文词元（含非 ASCII）：子串匹配——中文没有词边界问题，「缓存」命中「封装缓存读写」是有效信号。
  - ≥6 字符 ASCII 词元：子串匹配——长词几乎不会偶然出现在别的词里。
  - ≤5 字符 ASCII 词元（"cache"/"lock"/"http"）：只允许整词前缀——"http" 命中
    `HttpServletRequest`（切词后 http 是整词）、路径段 `io/`、`IOService`；不再命中 `Configuration`。
  */
function tokenHits(token: string, text: string): boolean {
  if (/[^\x00-\x7F]/.test(token)) return text.includes(token);
  if (token.length >= 6) return text.includes(token);
  return wordsOf(text).some((word) => word.startsWith(token));
}

/**
  候选按模块主题排序（2026-09-18 由「树序前 40」改语义排序；2026-09-20 补词边界与零分兜底）：
  - 路径命中 +20、候选摘要命中 +10、**锚点文件的 L1 摘要**命中 +15——目录聚合节点的模板摘要
    （「含 N 个可分析文件」）没有信号，文件摘要才有；这也是推荐入口在业务仓不相关的主因。
  - 其他模块已推荐的路径 -50：跨模块去重，压「不同 chip 推荐重合」。
  - 非零候选不足 15 时用 **boostPaths（入口点 + git 热点，调用方给）** 按序补零分候选：
    真仓实测「语言特性」全池 0 分，旧兜底=路径字典序前 15，送进模型的是 docs/ 与 Grafana YAML——
    字典序是纯噪声，入口/热点至少是「值得先读的代码」。boost 补位后仍不足才落字典序。
    （负分候选不参与补位：那是去重惩罚的主动判断，不是无信号。）
  */
export function rankEntryCandidates(
  candidates: Candidate[],
  tokens: string[],
  fileSummaries: Map<string, string>,
  avoidPaths: Set<string> = new Set(),
  boostPaths: readonly string[] = []
): Candidate[] {
  type Scored = { candidate: Candidate; score: number };
  const scored: Scored[] = candidates.map((candidate) => {
    const path = candidate.path.toLowerCase();
    const summary = candidate.summary.toLowerCase();
    const fileSummary = (fileSummaries.get(candidate.path) ?? "").toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (tokenHits(token, path)) score += 20;
      if (tokenHits(token, summary)) score += 10;
      if (tokenHits(token, fileSummary)) score += 15;
    }
    if (avoidPaths.has(candidate.path)) score -= 50;
    return { candidate, score };
  });
  // id 决胜：同一文件里多个函数节点的相对顺序不能依赖候选的进入顺序（树遍历序一改，
  // 排序后 top15 就变、缓存键跟着变——微观归组这类纯结构改动会白白重烧选择层）。
  const compareScore = (left: Scored, right: Scored): number =>
    right.score - left.score || left.candidate.path.localeCompare(right.candidate.path) || left.candidate.id.localeCompare(right.candidate.id);
  const positives = scored.filter((item) => item.score > 0).sort(compareScore);
  const negatives = scored.filter((item) => item.score < 0).sort(compareScore);
  const zeros = scored.filter((item) => item.score === 0).sort((left, right) => left.candidate.path.localeCompare(right.candidate.path) || left.candidate.id.localeCompare(right.candidate.id));
  const boostRank = new Map(boostPaths.slice(0, MAX_BOOST_PATHS).map((path, index) => [path, index]));
  const isBoosted = (item: Scored): boolean => boostRank.has(item.candidate.path);
  // 零分候选按 boost 优先排好队列后，**每路径限 2 个**再进池：真仓实测热点文件的十几个方法
  // 会成块挤满 top15（同路径在字典序里相邻），模型只能看到一文件。限流后仍不足 15 时放开设限。
  const zeroQueue = [
    ...zeros.filter(isBoosted).sort((left, right) => boostRank.get(left.candidate.path)! - boostRank.get(right.candidate.path)!),
    ...zeros.filter((item) => !isBoosted(item))
  ];
  const perPath = new Map<string, number>();
  const cappedZeros: Scored[] = [];
  const overflowZeros: Scored[] = [];
  for (const item of zeroQueue) {
    const seen = perPath.get(item.candidate.path) ?? 0;
    if (seen < 2) {
      perPath.set(item.candidate.path, seen + 1);
      cappedZeros.push(item);
    } else {
      overflowZeros.push(item);
    }
  }
  // 正分 → 限流零分（boost 在前）→ 破例放回的溢出零分 → 被去重惩罚的负分候选垫底
  return [...positives, ...cappedZeros, ...overflowZeros, ...negatives]
    .slice(0, MAX_LLM_CANDIDATES)
    .map((item) => item.candidate);
}

/* ------------------------------------------------------------------ */
/* 主题翻译层（P1）：中文教学概念 → 本仓库英文检索词                     */
/* ------------------------------------------------------------------ */

/** 仓库路径词指纹：全部候选路径切词后按出现频次取前 40，给翻译模型「这个仓大概用什么栈」。 */
function themeFingerprint(candidates: Candidate[]): string[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const word of new Set(wordsOf(candidate.path))) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([word]) => word.length >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 40)
    .map(([word]) => word);
}

/**
  每层实际输入的口径版本，进各自缓存键：
  - `candidate-v2`（2026-09-20）：词边界打分 + boost 补位 + 翻译词元入池。旧键的缓存行全部作废——
    那批「字典序前 15 喂模型」的推荐结果没有保留价值。
  - `expand-v2`（2026-09-20）：v1 实测模型把仓库词表照抄成 controller/service/utils 泛化词，池子被结构词灌满。
    提示词禁止泛化词后旧产出必须作废，故 bump。
  系统提示词、打分权重或 `MAX_*` 变了，送进模型的 payload 可以一字不变，这类失效只有版本号管得了。
*/
const ENTRY_INPUT_VERSION = "candidate-v2";
const EXPAND_INPUT_VERSION = "expand-v2";

interface ExpansionRecord {
  tokens: string[];
}

const expandCache = new Map<string, { value: ExpansionRecord; at: number }>();

async function expandThemeTokensCached(input: { repositoryId: string; moduleLabel: string; moduleHint: string; fingerprint: string[]; provider: LlmProvider; database?: TutorDatabase }): Promise<ExpansionRecord & { usage?: LlmUsage }> {
  const key = layerCacheKey({
    layer: "entry-expand",
    repositoryId: input.repositoryId,
    contractVersion: EXPAND_INPUT_VERSION,
    modelVersion: input.provider.modelVersion,
    payload: { module: { label: input.moduleLabel, hint: input.moduleHint }, fingerprint: input.fingerprint }
  });
  const now = Date.now();
  const hit = expandCache.get(key);
  if (hit && now - hit.at < ENTRY_CACHE_TTL_MS) {
    expandCache.delete(key);
    expandCache.set(key, hit);
    input.database?.touchLayerCache(key, now);
    return hit.value;
  }
  const stored = input.database?.getLayerCache<ExpansionRecord>(key);
  if (stored && now - stored.at < ENTRY_PERSISTED_TTL_MS && Array.isArray(stored.value.tokens)) {
    expandCache.set(key, { value: stored.value, at: now });
    trimToNewest(expandCache, ENTRY_CACHE_MAX);
    input.database?.touchLayerCache(key, now);
    return stored.value;
  }
  try {
    const response = await input.provider.complete({
      system: [
        "你是代码教学产品的检索规划器。给定一个中文学习模块主题和一个代码仓库中常见的路径/标识符词表，",
        `产出该主题在该仓库里最可能以英文标识符、目录名或注解名形式出现的检索词（最多 ${MAX_EXPANDED_TOKENS} 个，全小写，短而具体，如 timeout、retry、distributedlock、redis）。`,
        "只收录**承载该主题语义**的词：泛化的结构词（controller、service、config、utils、api 这类每层都有的命名）会淹没真信号，禁止输出；仓库词表只用来判断技术栈与命名习惯，不是让你照抄。",
        "只收录与该主题真实相关的词；主题在本仓库没有对应代码时输出空数组。",
        "严格输出 JSON 字符串数组，如 [\"http\",\"timeout\",\"retry\"]，不要输出其他文字。"
      ].join(""),
      user: JSON.stringify({ module: { label: input.moduleLabel, hint: input.moduleHint }, repoVocabulary: input.fingerprint }),
      maxTokens: 400,
      temperature: 0.1,
      scene: "map.entry-expand"
    });
    const tokens = parseExpansionTokens(response.text);
    if (!tokens) {
      // 解析不出数组=模型行为异常，与调用失败同样不缓存，下次重试
      console.error("[entry-suggest] 主题翻译响应无法解析为字符串数组，忽略扩展词");
      return { tokens: [] };
    }
    const record: ExpansionRecord = { tokens };
    expandCache.set(key, { value: record, at: now });
    trimToNewest(expandCache, ENTRY_CACHE_MAX);
    input.database?.putLayerCache(key, record); // 「[]」是合法答案（该主题在本仓无对应代码），同样落盘
    return { ...record, usage: response.usage };
  } catch (error) {
    // 翻译失败不致命：退化为只用原始词元打分（≈ P1 之前的行为），且**不缓存**，下次重试
    console.error("[entry-suggest] 主题翻译调用失败，本次跳过扩展词:", error instanceof Error ? error.message : error);
    return { tokens: [] };
  }
}

function parseExpansionTokens(text: string): string[] | undefined {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(jsonText.slice(start, end + 1));
    if (!Array.isArray(parsed)) return undefined;
    const tokens = parsed.filter((item): item is string => typeof item === "string" && /^[a-z0-9-]{2,}$/.test(item.toLowerCase().trim()));
    return [...new Set(tokens.map((token) => token.toLowerCase().trim()))].slice(0, MAX_EXPANDED_TOKENS);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 选择层结果缓存（三级：内存 → SQLite → 计算）                          */
/* ------------------------------------------------------------------ */

/** 推荐入口结果缓存：键 = 层名 + 仓库 + **本层实际输入**（模块主题 + 排好序的候选，含翻译词元的效果）。
    GUI 每次进入教学页都会触发该请求，实测同一输入反复计费（8 次调用 2/3 输入完全相同）。
    非空结果与「模型主动判空」（declined）都缓存——后者是可信答案；只有失败回落的空列表不缓存，
    否则会把一次网络抖动固化成永久无推荐。键里带上候选清单本身（含去重与 boost 的效果），
    「输入相同 ⇒ 模型看到的问题相同 ⇒ 可直接复用」这一条不需要额外论证。 */
interface EntryRecord {
  entries: SuggestedEntry[];
  declined?: boolean;
}

const entryCache = new Map<string, { value: EntryRecord; at: number }>();
const ENTRY_CACHE_TTL_MS = 10 * 60_000;
const ENTRY_CACHE_MAX = 100;
/** 持久层的闲置 TTL：键是输入精确哈希，过期只是垃圾回收，不是可信性防线（与流程层同一套机制）。 */
const ENTRY_PERSISTED_TTL_MS = 7 * 24 * 60 * 60_000;

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

/** 清空内存态缓存与去重记录：供测试隔离回合间状态（也用来模拟 engine 重启，验证 SQLite 持久层）。
    换仓/卸载路径**不**调它——两者都已按 `repositoryId` 分键，跨仓库不会串味，且都有 TTL + 条数上限。 */
export function clearModuleEntryCache(): void {
  entryCache.clear();
  expandCache.clear();
  recentEntryPaths.clear();
}

export async function suggestModuleEntriesCached(input: { repositoryId: string; tree: CourseTree; moduleLabel: string; moduleHint: string; provider: LlmProvider; fileSummaries?: Map<string, string>; boostPaths?: string[]; database?: TutorDatabase }): Promise<ModuleEntrySuggestion> {
  // 跨模块去重：其他模块最近推荐过的路径在排序时降权（同模块重进不降，避免「换着花样推同一个」被矫枉过正）
  const existing = recentEntryPaths.get(input.repositoryId);
  // 过期的记录不读也不续用，直接由下面的新 Map 顶掉
  const paths = existing && Date.now() - existing.at < ENTRY_CACHE_TTL_MS ? existing.paths : new Map<string, string>();
  const avoidPaths = new Set<string>();
  for (const [path, module] of paths) if (module !== input.moduleLabel) avoidPaths.add(path);

  const pool = collectCandidates(input.tree);
  const expansion = await expandThemeTokensCached({ repositoryId: input.repositoryId, moduleLabel: input.moduleLabel, moduleHint: input.moduleHint, fingerprint: themeFingerprint(pool), provider: input.provider, database: input.database });
  const tokens = [...themeTokens(input.moduleLabel, input.moduleHint), ...expansion.tokens];
  const candidates = rankEntryCandidates(pool, tokens, input.fileSummaries ?? new Map(), avoidPaths, input.boostPaths ?? []);
  if (!candidates.length) return { entries: [] };

  const key = layerCacheKey({
    layer: "entry-suggest",
    repositoryId: input.repositoryId,
    contractVersion: ENTRY_INPUT_VERSION,
    modelVersion: input.provider.modelVersion,
    payload: { module: { label: input.moduleLabel, hint: input.moduleHint }, candidates }
  });
  const now = Date.now();
  const hit = entryCache.get(key);
  if (hit && now - hit.at < ENTRY_CACHE_TTL_MS) {
    entryCache.delete(key);
    entryCache.set(key, hit); // 刷新 LRU 新近度
    input.database?.touchLayerCache(key, now);
    return { ...hit.value };
  }
  // 内存过期/缺失时查 SQLite：engine 重启会清空内存层，持久层让重启不重烧（与流程层同一套机制）
  const stored = input.database?.getLayerCache<EntryRecord>(key);
  if (stored && now - stored.at < ENTRY_PERSISTED_TTL_MS && (stored.value.entries.length || stored.value.declined)) {
    entryCache.set(key, { value: stored.value, at: now });
    trimToNewest(entryCache, ENTRY_CACHE_MAX);
    input.database?.touchLayerCache(key, now);
    return { ...stored.value };
  }
  const suggestion = await selectFromCandidates({ candidates, moduleLabel: input.moduleLabel, moduleHint: input.moduleHint, provider: input.provider });
  const usable = suggestion.entries.length > 0 || suggestion.declined === true;
  if (usable) {
    const record: EntryRecord = { entries: suggestion.entries, ...(suggestion.declined ? { declined: true } : {}) };
    for (const entry of suggestion.entries) {
      paths.delete(entry.path);
      paths.set(entry.path, input.moduleLabel); // 先删后设：刷新该路径的新近度
    }
    trimToNewest(paths, RECENT_ENTRY_PATHS_MAX_PER_KEY);
    recentEntryPaths.delete(input.repositoryId); // set 不移动已有键的位置，删后重设才刷新 key 的新近度
    recentEntryPaths.set(input.repositoryId, { paths, at: now });
    trimToNewest(recentEntryPaths, RECENT_ENTRY_PATHS_MAX_KEYS);
    entryCache.set(key, { value: record, at: now });
    trimToNewest(entryCache, ENTRY_CACHE_MAX);
    input.database?.putLayerCache(key, record); // 失败回落的空列表（非 declined）不落盘
  }
  // 记账合并到一条：翻译层的选择层的用量都发生在这个请求里（缓存命中时两者都没有 usage）
  return { ...suggestion, usage: sumUsage(expansion.usage, suggestion.usage) };
}

function sumUsage(left: LlmUsage | undefined, right: LlmUsage | undefined): LlmUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const cacheHit = left.promptCacheHitTokens ?? right.promptCacheHitTokens;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheHit === undefined ? {} : { promptCacheHitTokens: cacheHit })
  };
}

function pickEntries(text: string, candidates: Candidate[]): { entries: SuggestedEntry[]; declined: boolean } {
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start < 0 || end <= start) return { entries: [], declined: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.slice(start, end + 1));
  } catch {
    return { entries: [], declined: false };
  }
  if (!Array.isArray(parsed)) return { entries: [], declined: false };
  // 解析成功且模型明确给了空数组 = 主动判空（P4 的拒绝出口）；条目全被过滤掉不算（那是坏输出）
  if (parsed.length === 0) return { entries: [], declined: true };
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
  return { entries, declined: false };
}
