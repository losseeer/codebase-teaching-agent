/**
  界面侧唯一入口：跨进程流动的形状（`contracts.ts` 的 zod 契约）加上界面真正消费的领域类型与只读辅助函数。
  引擎内部领域模型仍住在 `index.ts`；界面从这里取，不再直接依赖引擎内部模块的导出。
*/
export * from "./contracts.js";

export type {
  CourseNode,
  CourseTree,
  CourseTier,
  CourseTierEvidence,
  Diagram,
  DiagramBody,
  DiagramEdge,
  DiagramEdgeOrigin,
  DiagramGroup,
  DiagramNode,
  DiagramNodeKind,
  DiagramSource,
  DiagramSummary,
  DiagramVersion,
  Exercise,
  ExerciseAnswer,
  ExerciseGradingMode,
  ExerciseKind,
  ExerciseLanguage,
  ExerciseResult,
  FadedState,
  FileTreeNode,
  LearnerProfile,
  MasteryRecord,
  PracticeSummary,
  RepositoryIndex,
  RepositoryOverlays,
  SuggestedEntry,
  TraceScalar,
  TutorSession,
  TutorSettings,
  UiJournalEventType
} from "./index.js";

export { isDocumentationPath, STYLE_BAND_LABEL, styleBand, UI_JOURNAL_EVENTS } from "./index.js";
