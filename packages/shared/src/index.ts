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

export type EvidenceStrength = "direct" | "indirect" | "speculative";
export type VerificationStatus = "verified" | "needs_review" | "skipped";

export interface Evidence {
  id: string;
  strength: EvidenceStrength;
  source: "package_manifest" | "config" | "readme" | "git_commit" | "source" | "heuristic";
  excerpt: string;
  anchor?: SourceAnchor;
}

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
  kind: "overview" | "workflow" | "module" | "decision" | "implementation";
  anchors: SourceAnchor[];
  children: CourseNode[];
  evidence?: Evidence[];
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
  decision?: DecisionUnit;
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

export interface DecisionUnit {
  id: string;
  title: string;
  claim: string;
  summary: string;
  evidence: Evidence[];
  confidence: EvidenceStrength;
  anchors: SourceAnchor[];
  verification: AssertionCheck[];
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
  decisions: DecisionUnit[];
  implementations: ImplementationUnit[];
  quality: QualityReport;
  versionStamp: string;
  lastIncrementalUpdate?: { changedPaths: string[]; impactedPaths: string[]; at: string };
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

export type ExerciseKind = "output_prediction" | "change_localization" | "impact_analysis" | "decision_defense";
export type ExerciseInputMode = "text" | "multi_select" | "evidence_and_text";
export type ExerciseGradingMode = "execution" | "set_match" | "rubric";
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
  rationale?: string;
}

export interface RubricCriterion {
  id: string;
  label: string;
  score: number;
  maxScore: number;
  feedback: string;
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
  matchedIds?: string[];
  missingIds?: string[];
  unexpectedIds?: string[];
  rubric?: RubricCriterion[];
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
  | "token_usage";

export interface JournalEvent {
  id: string;
  type: JournalEventType;
  at: string;
  repositoryId: string;
  sessionId?: string;
  payload: Record<string, string | number | boolean | null>;
}

export interface ServerEvent {
  type: "import.progress" | "repository.updated" | "session.delta" | "session.complete" | "companion.suggestion";
  payload: Record<string, unknown>;
}
