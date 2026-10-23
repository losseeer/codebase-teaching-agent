export type {
  ChatScope,
  ChatThread,
  ChatThreadMessage,
  CostBucket,
  CostComponent,
  CostDay,
  CostSummary,
  ImportJob,
  JobPhase,
  RepositoryCatalogEntry,
  RepositoryFreshness,
  RepositoryFreshnessVerdict,
  RepositoryMountReason,
  ScopedStreamFrame,
  ScopedStreamProgress,
  ServerEvent,
  TeachingProgress,
  TurnScene
} from "./contracts.js";
export { checkContract, ContractViolation, scopedStreamProgressSchema, serverEventSchema, importJobSchema, repositoryCatalogEntrySchema, costSummarySchema, chatThreadSchema, chatThreadMessageSchema } from "./contracts.js";

/**
  引擎侧共享出口。跨进程流动的形状住在 `contracts.ts`（zod schema 反推类型）；
  界面只从 `wire.ts` 取（contracts + 界面真正消费的领域类型），不再直接依赖这里的引擎内部模型
  （图、切片、练习……）与辅助函数。
*/

export * from "./repository-index.js";
export * from "./external-category.js";
export * from "./diagram.js";
export * from "./import-estimate.js";
export * from "./style-band.js";
export * from "./teaching-policy.js";
export * from "./tutor-settings.js";
export * from "./dependency-graph.js";
export * from "./language-capabilities.js";
export * from "./static-facts.js";
export * from "./repository-analysis.js";
export * from "./route-seams.js";
export * from "./exercises.js";
export * from "./learner-profile.js";
export * from "./journal.js";
export * from "./engine-trace.js";
