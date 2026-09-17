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

/** 流程环节的性质；界面据此给不同的徽标（判断/回环与普通环节的读法不同）。 */
export type FlowStageKind = "entry" | "stage" | "decision" | "loop" | "exit";

/** 环节关联的一个文件。**只在节点详情里展示**——画布上不出现路径，避免流程视图退化成定位清单。 */
export interface FlowStageFile {
  path: string;
  line: number;
  /** 该文件在这个环节里承担什么（≤20 字） */
  note?: string;
}

/**
 * 流程视图的一个环节：由 LLM 依据静态证据（依赖关系、符号、静态调用链）生成。
 * 与静态调用链的区别正是它存在的理由——回调注册（`add_node("evaluate", evaluate)`）、
 * 反射、依赖注入这类编排不会产生调用边，静态图看不见，而模型可以从文件与符号语义里读出来。
 */
export interface FlowStage {
  /** 展示序号，1 起 */
  order: number;
  kind: FlowStageKind;
  /** 环节名（≤14 字） */
  title: string;
  /** 一句话说明该环节做什么（≤60 字） */
  detail: string;
  /** 关联文件；全部经仓库索引校验，不存在的路径不会出现在这里 */
  files: FlowStageFile[];
  /** 分叉说明：该环节的多条去向与判断依据（有一个以上去向时给出） */
  branches: string[];
  /** 回环目标序号：回到本流程内更靠前的某个环节（有回边时给出） */
  loopsTo?: number;
}

/** 一条从入口出发的执行流程（流程视图的数据源）。 */
export interface RepositoryFlow {
  entry: SourceAnchor;
  /** 整条流程的标题（≤18 字） */
  title: string;
  /** 流程总述（≤100 字） */
  summary: string;
  stages: FlowStage[];
  /** 已知边界：模型自述的不确定处、被校验丢弃的内容、或降级说明。界面原样展示，不吞掉。 */
  caveats?: string;
  generatedAt: string;
}

/** 流程环节数上限；超出即截断，并在 `caveats` 里明示截断了多少。 */
export const FLOW_MAX_STAGES = 12;

/** 流程生成来源。`static` = 静态调用链降级（LLM 未配置、预算触顶或调用失败），必须显式告知用户。 */
export interface RepositoryFlowResult {
  flow: RepositoryFlow;
  source: "llm" | "static";
  /** source=static 时的原因 */
  reason?: string;
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

/**
  学习日志事件类型。分两类：

  - 引擎侧（学习语义）：unit_mastered 起至 file_read；由引擎在状态机 / 工具循环 / 成本核算里写。
  - UI 侧（交互动作）：flow_node_selected 起至 repository_switched；由 GUI 经 `POST /api/repositories/:id/journal` 写。
    这条契约来自设计文档第 8 章 PRINCIPLE 03「可观测」：每次切节点、打开文件、切换模块、提交练习都必须有事件可查。

  ⚠️ 改这里必须同步 `packages/engine/src/store/journal.ts` 的运行时 `eventTypes` Set——
  它才是 `Journal.append` 的白名单，漏同步会在运行期抛 `Unknown journal event`。
  append-only：只许新增，不许改名或删除既有取值。
  */
export type JournalEventType =
  // 引擎侧
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
  | "file_read"
  // UI 侧
  | "flow_node_selected"
  | "file_anchored"
  | "file_opened"
  | "line_located"
  | "module_switched"
  | "exercise_submitted"
  | "repository_switched";

export interface JournalEvent {
  id: string;
  type: JournalEventType;
  at: string;
  repositoryId: string;
  sessionId?: string;
  /** 产生该事件的请求 traceId；后台任务（导入 / 监听刷新）无请求上下文时为 null。 */
  traceId?: string | null;
  payload: Record<string, string | number | boolean | null>;
}

/** 引擎工作日志（trace）里允许出现的标量——与 journal payload 同口径，避免结构化对象随版本漂移。 */
export type TraceScalar = string | number | boolean | null;

/**
  引擎工作日志的事件种类。只描述「引擎这个进程在干活」，不描述对话语义：
  - http     一次 HTTP 请求（method / url / status / 耗时）
  - import   导入任务（索引 → 摘要 → 建课 → LLM 润色的阶段推进与结果）
  - reindex  挂载仓库被写入触发的重分析
  - degrade  降级与预算熔断（不静默：降级必须留痕）
  - boot     启动分段计时
  LLM 调用明细不在此列——它落在 `~/.codebase-tutor/llm.log`，两处靠 traceId 关联（单一事实来源，不双写）。
  */
export type EngineTraceKind = "http" | "import" | "reindex" | "degrade" | "boot";

export interface EngineTraceEvent {
  at: string;
  kind: EngineTraceKind;
  /** 关联键：同一请求产生的 http / llm / journal 事件共享它；后台任务为 null。 */
  traceId: string | null;
  durationMs?: number | null;
  detail: Record<string, TraceScalar>;
}

export interface ServerEvent {
  type: "import.progress" | "repository.updated" | "session.delta" | "session.complete" | "session.progress" | "companion.suggestion";
  payload: Record<string, unknown>;
}
