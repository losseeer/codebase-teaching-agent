import { z } from "zod";

/**
  引擎与界面之间的运行时契约：类型由 schema 反推（z.infer），界面在边界校验形状，不符即抛错。
  只覆盖跨进程的热形状：地址簿、导入任务、事件流帧、会话线程、成本读数；课程树/图/练习在 index.ts 声明。
*/

/* ------------------------------------------------------------------ */
/* 地址簿与导入                                                        */
/* ------------------------------------------------------------------ */

export const jobPhaseSchema = z.enum(["queued", "indexing", "summarizing", "completed", "failed"]);
export type JobPhase = z.infer<typeof jobPhaseSchema>;

/** 一条导入任务：`GET /api/imports/:jobId` 的返回体，也是 `import.progress` 帧的 payload。 */
export const importJobSchema = z.object({
  id: z.string(),
  repositoryPath: z.string(),
  repositoryId: z.string().optional(),
  phase: jobPhaseSchema,
  progress: z.number(),
  message: z.string(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  /** 是否参考注释导入；显式值写入该仓 settings，换口径需重新导入。 */
  summaryHeaderComments: z.boolean().optional()
});
export type ImportJob = z.infer<typeof importJobSchema>;

/**
  挂载仓库的新鲜度判定（只报告，不触发重分析）：
  stale = 磁盘内容与 versionStamp 不一致；drifted = HEAD 变了但内容哈希没变；unknown = 产物没记 HEAD。
*/
export const repositoryFreshnessVerdictSchema = z.enum(["fresh", "drifted", "stale", "unknown"]);
export type RepositoryFreshnessVerdict = z.infer<typeof repositoryFreshnessVerdictSchema>;

export const repositoryFreshnessSchema = z.object({
  verdict: repositoryFreshnessVerdictSchema,
  /** 产物生成时间 */
  analyzedAt: z.string(),
  versionStamp: z.string(),
  contentChanged: z.boolean(),
  changedFiles: z.number(),
  headAtAnalysis: z.string().optional(),
  headNow: z.string().optional()
});
export type RepositoryFreshness = z.infer<typeof repositoryFreshnessSchema>;

/** 地址簿里的一条（引擎不读产物就能列出；`mounted` 才带新鲜度）。 */
export const repositoryCatalogEntrySchema = z.object({
  repositoryId: z.string(),
  repositoryPath: z.string(),
  /** 目录名，界面显示用 */
  name: z.string(),
  mounted: z.boolean(),
  /** 目录是否还在；不存在时条目保留并如实标注 */
  exists: z.boolean(),
  /** 产物是否就绪（`.tutor/tutor.db` 四件套）；未挂载时不探测 */
  artifactsReady: z.boolean().optional(),
  freshness: repositoryFreshnessSchema.optional(),
  /** 增量监听是否活着；仅挂载的仓有值 */
  watching: z.boolean().optional(),
  /** 监听启动失败或中途死亡的报错原文 */
  watchError: z.string().optional(),
  /** 监听是否被人为挂起；与 watching:false（引擎故障）区分 */
  watchPaused: z.boolean().optional(),
  /** 挂起到何时（ISO 串）；到点自动恢复 */
  watchPausedUntil: z.string().optional(),
  /** 预算闸门失效时的警告文本；仅失效时有值 */
  budgetGateNotice: z.string().optional()
});
export type RepositoryCatalogEntry = z.infer<typeof repositoryCatalogEntrySchema>;

/** 懒挂载失败的原因；GUI 据此区分清工作区还是留给用户处置。 */
export const repositoryMountReasonSchema = z.enum(["not_in_catalog", "directory_missing", "artifacts_incomplete"]);
export type RepositoryMountReason = z.infer<typeof repositoryMountReasonSchema>;

/* ------------------------------------------------------------------ */
/* 会话线程                                                            */
/* ------------------------------------------------------------------ */

export const chatScopeSchema = z.enum(["teach", "map", "practice"]);
export type ChatScope = z.infer<typeof chatScopeSchema>;

/** 运行时判断 scope 取值合法；ChatScope 类型只管编译期。 */
export function isChatScope(value: unknown): value is ChatScope {
  return chatScopeSchema.safeParse(value).success;
}

/** 对话线程的头；正文在 chat_message，软删由列表读侧过滤。 */
export const chatThreadSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  scope: chatScopeSchema,
  /** 教学作用域：`file:<仓内路径>` 或 `dir:<仓内目录>`；map / practice 线程可不填。 */
  scopeRef: z.string().optional(),
  exerciseId: z.string().optional(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type ChatThread = z.infer<typeof chatThreadSchema>;

/** 线程的一条消息；error 非空 = 这一轮失败，失败也入库。 */
export const chatThreadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
  error: z.string().optional()
});
export type ChatThreadMessage = z.infer<typeof chatThreadMessageSchema>;

/* ------------------------------------------------------------------ */
/* 成本读数                                                            */
/* ------------------------------------------------------------------ */

/** 一个计费档位：输入拆「未命中 / 缓存命中」两档价，输出单独一档。 */
export const costComponentSchema = z.object({
  label: z.enum(["未命中输入", "命中输入（缓存）", "输出"]),
  tokens: z.number(),
  ratePerMillionUsd: z.number(),
  /** true = 未配置命中价，按输入价计 */
  rateFallback: z.boolean(),
  estimatedCostUsd: z.number()
});
export type CostComponent = z.infer<typeof costComponentSchema>;

/** 成本聚合的一个分桶（按场景或按 provider），一条 `token_usage` 记一个回合。 */
export const costBucketSchema = z.object({
  label: z.string(),
  turns: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number()
});
export type CostBucket = z.infer<typeof costBucketSchema>;

/** 按自然日聚合的用量（取 journal `at` 的前 10 位）。 */
export const costDaySchema = z.object({
  date: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number()
});
export type CostDay = z.infer<typeof costDaySchema>;

export const costSummarySchema = z.object({
  sessionId: z.string().optional(),
  /** 输入总用量（含命中那部分，与 provider 的 prompt_tokens 同口径） */
  inputTokens: z.number(),
  /** 按未命中价计费的那部分输入 = inputTokens − cacheHitTokens（逐条相减后求和，不为负） */
  billedInputTokens: z.number(),
  /** 命中前缀缓存、按命中价计费的那部分输入；provider 没上报时为 0 */
  cacheHitTokens: z.number(),
  outputTokens: z.number(),
  estimatedCostUsd: z.number(),
  monthlyBudgetUsd: z.number(),
  remainingBudgetUsd: z.number(),
  mode: z.enum(["normal", "degraded"]),
  /** 本月计入的回合数 */
  turns: z.number(),
  /** 三档计费的逐项明细；estimatedCostUsd 就是这三项之和 */
  costComponents: z.array(costComponentSchema),
  /** 三档单价全未配置时为 false：金额恒 0，预算闸门不生效。判据在 engine cost/cost.ts。 */
  pricingConfigured: z.boolean(),
  /** 因预算已达上限而走本地规则（不付 token）的回合数 */
  degradedTurns: z.number(),
  byScene: z.array(costBucketSchema),
  byProvider: z.array(costBucketSchema),
  byDay: z.array(costDaySchema)
});
export type CostSummary = z.infer<typeof costSummarySchema>;

/* ------------------------------------------------------------------ */
/* 流式帧：作用域对话流与全局事件流                                    */
/* ------------------------------------------------------------------ */

/** 回合场景名：与 journal 的 scene、引擎回合登记表同一套词。 */
export const turnSceneSchema = z.enum(["teach", "map_chat", "practice_chat"]);
export type TurnScene = z.infer<typeof turnSceneSchema>;

/** 教学回合过程提示；文案由界面定，思考帧不带轮数。 */
export const teachingProgressSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("thinking") }),
  z.object({ stage: z.literal("reading"), path: z.string() }),
  z.object({ stage: z.literal("searching"), query: z.string() }),
  z.object({ stage: z.literal("loading_skill"), skill: z.string() }),
  z.object({ stage: z.literal("editing_diagram") }),
  z.object({ stage: z.literal("querying_facts") }),
  z.object({ stage: z.literal("calling_external") })
]);
export type TeachingProgress = z.infer<typeof teachingProgressSchema>;

/**
  作用域对话流的过程帧与正文帧词表，引擎与界面的唯一登记处：
  新帧类必须先加在这里，两侧各有编译期穷尽守卫；done 载荷不在内，由各自返回体声明。
*/
export const scopedStreamProgressSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thinking") }),
  z.object({ type: z.literal("reading"), path: z.string() }),
  z.object({ type: z.literal("searching"), query: z.string() }),
  z.object({ type: z.literal("loading_skill"), skill: z.string() }),
  z.object({ type: z.literal("editing_diagram") }),
  z.object({ type: z.literal("querying_facts") }),
  z.object({ type: z.literal("calling_external") }),
  z.object({ type: z.literal("progress"), payload: teachingProgressSchema }),
  z.object({ type: z.literal("delta"), delta: z.string() })
]);
export type ScopedStreamProgress = z.infer<typeof scopedStreamProgressSchema>;

/** 一条流的完整帧词表：过程/正文 + 三条出口（done 载荷见上，仍是开放形状）。 */
export type ScopedStreamFrame =
  | ScopedStreamProgress
  | { type: "error"; error: string }
  | { type: "aborted"; scene: TurnScene }
  | { type: "done"; [key: string]: unknown };

/**
  全局事件流的广播事件；对话的 delta/progress 在各自响应流里。
  repository.updated = 产物变化；diagram_updated = 图库或当前图变化；几何拖动不广播。
*/
export const serverEventSchema = z.object({
  type: z.enum(["import.progress", "repository.updated", "diagram_updated"]),
  payload: z.record(z.string(), z.unknown())
});
export type ServerEvent = z.infer<typeof serverEventSchema>;

/* ------------------------------------------------------------------ */
/* 边界上的校验口                                                      */
/* ------------------------------------------------------------------ */

/** 契约失败：带契约名与不符的字段路径。 */
export class ContractViolation extends Error {
  constructor(contract: string, issues: string[]) {
    super(`${contract} 的形状不符：${issues.join("；")}`);
    this.name = "ContractViolation";
  }
}

/** 校验并返回窄化后的值；失败抛 `ContractViolation`（不静默降级、不补默认值）。 */
export function checkContract<S extends z.ZodType>(contract: S, value: unknown, name: string): z.infer<S> {
  const parsed = contract.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ContractViolation(name, parsed.error.issues.map((issue) => `${issue.path.join(".") || "(根)"}：${issue.message}`));
}
