export type JobPhase = "queued" | "indexing" | "summarizing" | "building_course" | "completed" | "failed";

export interface ImportJob {
  id: string;
  repositoryPath: string;
  repositoryId?: string;
  phase: JobPhase;
  progress: number;
  message: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface FileEntry {
  path: string;
  extension: string;
  bytes: number;
  lines: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileTreeNode[];
}

export interface Hotspot {
  path: string;
  changes: number;
}

export interface RepositoryIndex {
  repositoryId: string;
  repositoryPath: string;
  scannedAt: string;
  totalFiles: number;
  totalLines: number;
  files: FileEntry[];
  fileTree: FileTreeNode[];
  hotspots: Hotspot[];
}

export interface SourceAnchor {
  path: string;
  line: number;
  endLine?: number;
  label: string;
}

export type VerificationStatus = "verified" | "needs_review" | "skipped";

export interface AssertionCheck {
  statement: string;
  status: VerificationStatus;
  reason: string;
  anchors: SourceAnchor[];
}

export interface CourseNode {
  id: string;
  title: string;
  summary: string;
  kind: "overview" | "workflow" | "module" | "implementation";
  anchors: SourceAnchor[];
  children: CourseNode[];
  verification?: AssertionCheck[];
  /** Present on overview and paged responses when descendants are not yet loaded. */
  childCount?: number;
}

export interface CourseTree {
  repositoryId: string;
  modelVersion: string;
  generatedAt: string;
  root: CourseNode;
}

/** Lightweight first response for a large repository's course map. */
export interface RepositoryOverview {
  repositoryId: string;
  totalFiles: number;
  totalLines: number;
  hotspots: Hotspot[];
  root: CourseNode;
}

export interface CourseNodePage {
  parentId: string;
  offset: number;
  total: number;
  items: CourseNode[];
  nextOffset?: number;
}

export interface CourseNodeDetail {
  nodeId: string;
  implementation?: ImplementationUnit;
}

export interface ImportEstimate {
  cachedFiles: number;
  summarizedFiles: number;
  estimatedInputTokens: number;
  estimatedCostUsd: number;
  provider: string;
  modelVersion: string;
}

/** M1 policy is a continuous 0-100 value; M0 presets remain 35, 50 and 65. */
export type StyleLevel = number;

/**
  语言风格档位的判据与展示名 —— engine 与 GUI 的**唯一**来源（两侧都从这里取，不再各写阈值）。
  历史坑：harness 的本地回落文案曾写死 `>= 65`，与 policy 里的 67 不一致，滑块 65/66 两处口径不同。
  档位只决定基调和回显名；档**内**的逐步细化在 engine 的 harness/prompts.ts（那里的 `at` 阈值是叠加在档位之上的补充要求）。
  */
export const STYLE_BAND_THRESHOLDS = { rigorousMax: 33, plainMin: 67 } as const;

export type StyleBand = "plain" | "neutral" | "rigorous";

export const STYLE_BAND_LABEL: Record<StyleBand, string> = { rigorous: "严肃", neutral: "中性", plain: "通俗" };

/** 非有限值（NaN / Infinity）按中性处理，与 engine `validateStyle` 的回落值 50 落在同一档。 */
export function styleBand(style: number): StyleBand {
  if (!Number.isFinite(style)) return "neutral";
  if (style >= STYLE_BAND_THRESHOLDS.plainMin) return "plain";
  if (style <= STYLE_BAND_THRESHOLDS.rigorousMax) return "rigorous";
  return "neutral";
}

export type Pedagogy = "socratic" | "explanatory" | "practice";
export type DecompositionDepth = "macro" | "micro";
export type TeachingStage = "orient" | "procedure" | "concept" | "verify" | "confirmed";

export interface TeachingPolicy {
  level: StyleLevel;
  label: string;
  constraints: string[];
  pedagogy: Pedagogy;
  depth: DecompositionDepth;
}

export interface TutorSettings {
  style: StyleLevel;
  pedagogy: Pedagogy;
  depth: DecompositionDepth;
}

export interface TutorMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  stage?: TeachingStage;
}

export interface TutorSession {
  id: string;
  repositoryId: string;
  courseNodeId: string;
  style: StyleLevel;
  settings: TutorSettings;
  stage: TeachingStage;
  fallbackCount: number;
  messages: TutorMessage[];
  createdAt: string;
}

export interface SymbolInfo {
  id: string;
  name: string;
  kind: "function" | "class" | "method" | "variable";
  path: string;
  line: number;
  endLine: number;
  parameters: string[];
  language: "typescript" | "python" | "other";
  type?: string;
  referenceCount?: number;
}

export interface CallEdge {
  callerPath: string;
  callerSymbol?: string;
  calleePath: string;
  calleeSymbol?: string;
  line: number;
}

export interface DependencyGraphData {
  imports: Record<string, string[]>;
  calls: CallEdge[];
  symbols: SymbolInfo[];
  entrypoints: SourceAnchor[];
  semanticBackend: "lsp" | "static";
  lspStatus: { language: "typescript" | "python"; status: "available" | "fallback"; reason?: string }[];
}

export interface ImpactResult {
  changedPaths: string[];
  impactedPaths: string[];
  edges: { from: string; to: string; kind: "import" | "call" }[];
}

export interface ImplementationUnit {
  id: string;
  symbol: SymbolInfo;
  summary: string;
  inputs: string[];
  output: string;
  invariants: string[];
  boundaries: string[];
  traps: string[];
  verification: AssertionCheck[];
}

export interface QualityReport {
  generatedAt: string;
  micro: AssertionCheck[];
  macro: AssertionCheck[];
  skippedBecause?: string;
}

export interface RepositoryAnalysis {
  repositoryId: string;
  generatedAt: string;
  graph: DependencyGraphData;
  implementations: ImplementationUnit[];
  quality: QualityReport;
  versionStamp: string;
  lastIncrementalUpdate?: { changedPaths: string[]; impactedPaths: string[]; at: string };
}

/** 流程视图的一步：从入口出发、按调用关系逐环节展开。 */
export interface FlowStep {
  /** 展示序号，1 起 */
  order: number;
  /** 距入口的跳数（入口本身为 0） */
  depth: number;
  kind: "entry" | "call";
  /** 环节名 = 被调用函数/方法名；文件级回落时是文件名 */
  title: string;
  path: string;
  line: number;
  endLine?: number;
  /** 调用点：谁（函数）在哪一行发起了这次跳转 */
  from?: { title: string; path: string; line: number };
  /** 跨文件去重后的去向总数 */
  branches: number;
  /** 其中本次真正展开成新环节的数量（branches 大于它表示有去向未展开） */
  expanded: number;
  /** 回边：该环节调用的、正好是它自己上游环节的序号（真正的环） */
  loops: number[];
  /** 复用：该环节调用的、已在链上前文出现过的环节序号（不是环，只是共享下游） */
  revisits: number[];
  /** 同文件内部调用数（只计数、不展开） */
  sameFileCalls: number;
  language?: SymbolInfo["language"];
  parameters?: number;
}

export interface FlowPlan {
  entry: SourceAnchor;
  steps: FlowStep[];
  /** 被深度/分支/步数上限截断：链上还有可达环节未展开 */
  truncated: boolean;
  /** 未展开的下游环节数 */
  omitted: number;
}

/** 流程展开上限：默认 5 跳 / 每步最多 6 条分支 / 共 24 步，超出即停并在界面上明示。 */
export const FLOW_LIMITS = { maxDepth: 5, maxBranchesPerStep: 6, maxSteps: 24 } as const;

/**
 * 从入口按调用关系展开「流程」：沿 `analysis.graph.calls` 走**跨文件**跳
 * （同文件内部调用只计数、不展开——流程视图要表达的是模块之间的流转）。
 * 某一步的分支按「该去向自己还能展开出多长的链」排序、连续编号，各自的下游紧随其后，
 * 于是入口文件里那些收尾型调用（close、configure_logging 之类）不会把主线挤掉。
 * 逐步给出实现位置、调用点、分叉数、环（回到自己的上游）与复用（共享下游）。
 * 纯函数；数据不足时返回只有入口的骨架。
 */
export function buildFlowPlan(
  analysis: RepositoryAnalysis,
  entry: SourceAnchor,
  limits: { maxDepth: number; maxBranchesPerStep: number; maxSteps: number } = FLOW_LIMITS
): FlowPlan {
  const byId = new Map(analysis.graph.symbols.map((symbol) => [symbol.id, symbol]));
  const byCallerSymbol = new Map<string, CallEdge[]>();
  const byCallerPath = new Map<string, CallEdge[]>();
  const add = (map: Map<string, CallEdge[]>, key: string, call: CallEdge): void => {
    map.set(key, [...(map.get(key) ?? []), call]);
  };
  for (const call of analysis.graph.calls) {
    if (call.callerSymbol) add(byCallerSymbol, call.callerSymbol, call);
    add(byCallerPath, call.callerPath, call);
  }

  interface Cursor {
    key: string;
    title: string;
    path: string;
    line: number;
    endLine?: number;
    language?: SymbolInfo["language"];
    parameters?: number;
    calls: CallEdge[];
  }
  interface Branch {
    cursor: Cursor;
    /** 调用点所在行 */
    line: number;
    /** 发起这次调用的函数名 */
    caller: string;
  }
  const cursorOfCall = (call: CallEdge): Cursor | undefined => {
    const symbol = call.calleeSymbol ? byId.get(call.calleeSymbol) : undefined;
    if (symbol) {
      return {
        key: `symbol:${symbol.id}`,
        title: symbol.name,
        path: symbol.path,
        line: symbol.line,
        endLine: symbol.endLine,
        language: symbol.language,
        parameters: symbol.parameters.length,
        calls: byCallerSymbol.get(symbol.id) ?? []
      };
    }
    // 符号表里没有：只在没有 calleeSymbol 时回落文件级；有 id 却查不到说明数据不全，不编造
    if (call.calleeSymbol) return undefined;
    return { key: `file:${call.calleePath}`, title: fileTitle(call.calleePath), path: call.calleePath, line: 1, calls: byCallerPath.get(call.calleePath) ?? [] };
  };

  /** 跨文件去向：同一目标只留首次调用，按 (路径, 行) 稳定排序保证同一份数据得到同一条链。 */
  const branchesOf = (cursor: Cursor): Branch[] => {
    const found = new Map<string, Branch>();
    const calls = [...cursor.calls].sort((left, right) => left.calleePath.localeCompare(right.calleePath) || left.line - right.line);
    for (const call of calls) {
      if (call.calleePath === cursor.path) continue;
      const target = cursorOfCall(call);
      if (!target || found.has(target.key)) continue;
      found.set(target.key, { cursor: target, line: call.line, caller: (call.callerSymbol ? byId.get(call.callerSymbol)?.name : undefined) ?? cursor.title });
    }
    return [...found.values()];
  };
  const sameFileCallsOf = (cursor: Cursor): number => cursor.calls.filter((call) => call.calleePath === cursor.path).length;

  /** 从该去向出发还能走多长的链（记忆化；环上返回 0，避免深度发散）。 */
  const depthCache = new Map<string, number>();
  const depthOf = (cursor: Cursor, seen: Set<string>): number => {
    const cached = depthCache.get(cursor.key);
    if (cached !== undefined) return cached;
    if (seen.has(cursor.key)) return 0;
    seen.add(cursor.key);
    const next = branchesOf(cursor);
    const value = next.length ? 1 + Math.max(...next.map((branch) => depthOf(branch.cursor, seen))) : 0;
    seen.delete(cursor.key);
    depthCache.set(cursor.key, value);
    return value;
  };

  // 入口按「文件」起步：一个入口文件里的每个函数都可能是流程的第一跳
  const entryCursor: Cursor = { key: `file:${entry.path}`, title: fileTitle(entry.path), path: entry.path, line: entry.line, calls: byCallerPath.get(entry.path) ?? [] };
  const steps: FlowStep[] = [{
    order: 1,
    depth: 0,
    kind: "entry",
    title: entryCursor.title,
    path: entryCursor.path,
    line: entryCursor.line,
    branches: 0,
    expanded: 0,
    loops: [],
    revisits: [],
    sameFileCalls: 0
  }];
  const orderOf = new Map<string, number>([[entryCursor.key, 1]]);
  let truncated = false;
  let omitted = 0;
  const stack: { cursor: Cursor; depth: number; stepIndex: number; chain: { key: string; order: number }[] }[] = [
    { cursor: entryCursor, depth: 0, stepIndex: 0, chain: [] }
  ];

  while (stack.length) {
    const item = stack.pop()!;
    const step = steps[item.stepIndex];
    const branches = branchesOf(item.cursor).sort((left, right) =>
      depthOf(right.cursor, new Set()) - depthOf(left.cursor, new Set())
      || left.cursor.path.localeCompare(right.cursor.path)
      || left.cursor.line - right.cursor.line);
    step.branches = branches.length;
    step.sameFileCalls = sameFileCallsOf(item.cursor);
    if (item.depth >= limits.maxDepth) {
      if (branches.length) { truncated = true; omitted += branches.length; }
      continue;
    }
    const chain = [...item.chain, { key: item.cursor.key, order: step.order }];
    const descending: typeof stack = [];
    for (const branch of branches) {
      const ancestor = chain.find((link) => link.key === branch.cursor.key);
      if (ancestor) {
        step.loops = [...new Set([...step.loops, ancestor.order])].sort((left, right) => left - right);
        continue;
      }
      const known = orderOf.get(branch.cursor.key);
      if (known !== undefined) {
        step.revisits = [...new Set([...step.revisits, known])].sort((left, right) => left - right);
        continue;
      }
      if (step.expanded >= limits.maxBranchesPerStep || steps.length >= limits.maxSteps) {
        truncated = true;
        omitted += 1;
        continue;
      }
      steps.push({
        order: steps.length + 1,
        depth: item.depth + 1,
        kind: "call",
        title: branch.cursor.title,
        path: branch.cursor.path,
        line: branch.cursor.line,
        endLine: branch.cursor.endLine,
        from: { title: branch.caller, path: item.cursor.path, line: branch.line },
        branches: 0,
        expanded: 0,
        loops: [],
        revisits: [],
        sameFileCalls: 0,
        language: branch.cursor.language,
        parameters: branch.cursor.parameters
      });
      step.expanded += 1;
      orderOf.set(branch.cursor.key, steps.length);
      // 逆序入栈 → 优先级最高的分支先被展开
      descending.push({ cursor: branch.cursor, depth: item.depth + 1, stepIndex: steps.length - 1, chain });
    }
    for (let index = descending.length - 1; index >= 0; index -= 1) stack.push(descending[index]);
    if (step.expanded < step.branches) { truncated = true; omitted += step.branches - step.expanded; }
  }
  return { entry, steps, truncated, omitted };
}

/** 路径 → 展示用短名（去掉目录与扩展名）。 */
function fileTitle(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "") || base;
}

export interface CostSummary {
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  monthlyBudgetUsd: number;
  remainingBudgetUsd: number;
  mode: "normal" | "degraded";
}

export type ExerciseKind = "output_prediction" | "change_localization" | "impact_analysis" | "llm_rubric";
/** 规则出题族题型：题面/选项/标准答案全部由静态分析与受限执行产出（server 校验 / 缓存命中校验共用这一份）。 */
export const EXERCISE_KINDS: ExerciseKind[] = ["output_prediction", "change_localization", "impact_analysis"];
/** 练习题族：comprehension=程序理解题（规则出题、确定性判分），llm=LLM 出题（rubric 判分）。family 是实现层概念，对用户不可见。 */
export type ExerciseFamily = "comprehension" | "llm";
export type ExerciseInputMode = "text" | "multi_select" | "open";
export type ExerciseGradingMode = "execution" | "set_match" | "rubric";
/** rubric 判分的评分细则维度（LLM 出题时一并产出，存于引擎缓存，不下发 GUI）。 */
export interface RubricCriterion {
  dimension: string;
  description: string;
}
export type MasteryLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface ExerciseOption {
  id: string;
  label: string;
  detail?: string;
}

/** A learner-safe exercise. Expected answers remain in the engine cache. */
export interface Exercise {
  id: string;
  repositoryId: string;
  contentVersion: string;
  kind: ExerciseKind;
  targetUnitId: string;
  targetTitle: string;
  difficulty: MasteryLevel;
  title: string;
  prompt: string;
  anchors: SourceAnchor[];
  inputMode: ExerciseInputMode;
  gradingMode: ExerciseGradingMode;
  options?: ExerciseOption[];
  /** 练习题族；旧缓存记录无此字段视为 comprehension。 */
  family?: ExerciseFamily;
  /** llm 族：用户配置的出题主题标签（题面语义提示）。 */
  tag?: string;
  createdAt: string;
}

/** 教学模块「推荐入口」的单条 LLM 推荐（engine `/module-entries` 返回；id 必须能回查课程树节点）。 */
export interface SuggestedEntry {
  id: string;
  title: string;
  path: string;
  line: number;
  reason?: string;
}

export interface ExerciseAnswer {
  text?: string;
  selectedIds?: string[];
}

/** 知识模块分类关键词（GUI 模块 chips 与 engine 练习出题过滤共用的同一份口径）。 */
export const MODULE_KEYWORDS: Record<string, RegExp> = {
  network: /(router|route|http|api|请求|路由|网关|超时|重试|幂等|网络|接口|controller|server|client|endpoint|中间件)/i,
  os: /(cache|缓存|并发|concurren|thread|线程|进程|队列|queue|锁|lock|内存|memory|调度|io\b|buffer|池)/i,
  lang: /(type|类型|async|异步|await|error|错误|异常|exception|util|helper|parse|解析|闭包|回调|函数式|泛型)/i
};

/** 按关键词把文本归类到知识模块；默认 id 命中需在 moduleIds 内，都不命中归「other」。 */
export function classifyModuleId(text: string, moduleIds: string[]): string {
  for (const [id, pattern] of Object.entries(MODULE_KEYWORDS)) {
    if (pattern.test(text) && moduleIds.includes(id)) return id;
  }
  return "other";
}

export interface ExerciseResult {
  exerciseId: string;
  repositoryId: string;
  targetUnitId: string;
  kind: ExerciseKind;
  score: number;
  passed: boolean;
  automatic: boolean;
  gradingMode: ExerciseGradingMode;
  feedback: string;
  /** 反馈来源：rule=规则判分原文；llm_polished=LLM 润色的解释；llm_judge=rubric 判分产出。 */
  feedbackSource?: "rule" | "llm_polished" | "llm_judge";
  matchedIds?: string[];
  missingIds?: string[];
  unexpectedIds?: string[];
  reviewedAt: string;
  review: ReviewSchedule;
}

export interface MasteryRecord {
  unitId: string;
  level: MasteryLevel;
  attempts: number;
  successes: number;
  lastPracticedAt?: string;
}

export interface MasteryMapEntry extends MasteryRecord {
  successRate: number;
  dependencyEvents: number;
  averageHintDepth: number | null;
  lastStage?: TeachingStage;
}

export type FadedTransition = "fade" | "replenish" | "steady";

export interface FadedState {
  sampleCompleteness: 0 | 1 | 2;
  hintDepth: 0 | 1 | 2 | 3;
  stylePlainness: 0 | 1 | 2;
  mastered: boolean;
  transition: FadedTransition;
  reason: string;
  updatedAt?: string;
}

export interface RecommendedTutorSettings {
  settings: TutorSettings;
  reason: string;
  confidence: "low" | "medium" | "high";
}

export interface LearnerProfile {
  repositoryId: string;
  generatedAt: string;
  mastery: MasteryMapEntry[];
  faded: FadedState;
  fadedByUnit: Record<string, FadedState>;
  recommended: RecommendedTutorSettings;
}

export interface ReviewSchedule {
  exerciseId: string;
  unitId: string;
  repetitions: number;
  intervalDays: number;
  easinessFactor: number;
  dueAt: string;
  lastReviewedAt?: string;
}

export interface PracticeSummary {
  repositoryId: string;
  contentVersion: string;
  dueReviews: number;
  mastery: MasteryRecord[];
}

export type CompanionFlowState = "focused" | "transition" | "stuck";
export type CompanionSuggestionKind = "failure_recovery" | "impact_review" | "source_trace";
export type CompanionSuggestionStatus = "pending" | "accepted" | "dismissed" | "later";
export type CompanionAction = "accepted" | "dismissed" | "later";

/** Normalized shape accepted from a Claude Code PostToolUse hook. */
export interface ClaudePostToolUseEvent {
  hookEventName?: "PostToolUse";
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: string;
  cwd?: string;
  path?: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  sessionId?: string;
}

export interface CompanionSuggestion {
  id: string;
  repositoryId: string;
  eventId: string;
  kind: CompanionSuggestionKind;
  status: CompanionSuggestionStatus;
  title: string;
  body: string;
  reason: string;
  flow: CompanionFlowState;
  relevance: number;
  path?: string;
  anchors: SourceAnchor[];
  createdAt: string;
  actedAt?: string;
}

export interface CompanionHookResult {
  accepted: boolean;
  discarded: boolean;
  reason: string;
  flow: CompanionFlowState;
  relevance: number;
  latencyMs: number;
  suggestion?: CompanionSuggestion;
}

export interface CompanionSummary {
  pendingCount: number;
  actionCount: number;
  acceptanceRate: number | null;
}

export type JournalEventType =
  | "unit_mastered"
  | "exercise_result"
  | "hint_depth"
  | "dependency_event"
  | "style_shift"
  | "teach_moment"
  | "unassisted_test"
  | "action_veto"
  | "exercise_declined"
  | "token_usage"
  | "file_read";

export interface JournalEvent {
  id: string;
  type: JournalEventType;
  at: string;
  repositoryId: string;
  sessionId?: string;
  payload: Record<string, string | number | boolean | null>;
}

export interface ServerEvent {
  type: "import.progress" | "repository.updated" | "session.delta" | "session.complete" | "session.progress" | "companion.suggestion";
  payload: Record<string, unknown>;
}
