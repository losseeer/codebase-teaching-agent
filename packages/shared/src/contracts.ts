import { z } from "zod";

/**
  引擎与界面之间的运行时契约：把「形状」变成一样能在运行时被核对的东西。
  TS 类型在运行时不存在，边界两侧各写一份接口时，引擎改个字段名或换个取值，界面拿到 `undefined` 照样渲染，
  既不报错也不留痕。

  - 类型从 schema 反推（`z.infer`），没有两份声明可以互相漂移；
  - 界面在边界上校验：引擎回来的东西不符形状就当场报错，而不是把 `undefined` 画上屏；
  - 引擎照旧按这些类型构造，编不过 = schema 与产出的分歧在编译期就暴露。

  刻意只覆盖「跨进程流动的热形状」：地址簿、导入任务、事件流帧、会话线程、成本读数。
  课程树 / 图 / 练习这些大而递归的产物仍由 `index.ts` 声明（它们由引擎整体产出、字段多且深，
  一次性套 schema 的收益低于把两侧都改一遍的风险），要扩就按同样的写法往里加。
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
  /** 导入时选择的摘要口径：true=「参考注释导入」（slice-v2c 档），false=普通导入；undefined=不改该仓既有设置。
      显式值会写进该仓 settings（读-合并-写）；换口径只能重新导入。 */
  summaryHeaderComments: z.boolean().optional()
});
export type ImportJob = z.infer<typeof importJobSchema>;

/**
  挂载在引擎内存里的仓库的新鲜度判定（只报告，不触发任何重分析）：
  - `contentChanged` = 磁盘内容与产物记录的 `versionStamp` 不一致（真的过期了）；
  - `changedFiles` = 与落库 `contentHash` 不一致的文件数（告诉用户「改动集中在哪几处」，比只说「脏了」有用）；
  - HEAD 变了但内容哈希没变（切分支回到同一份内容、或提交移动但工作树相同）判 `drifted`——产物仍可用，只是要知道分析点在别的提交上；
  - 产物没记 HEAD 时判 `unknown`，界面明说「只比对了文件内容」。
*/
export const repositoryFreshnessVerdictSchema = z.enum(["fresh", "drifted", "stale", "unknown"]);
export type RepositoryFreshnessVerdict = z.infer<typeof repositoryFreshnessVerdictSchema>;

export const repositoryFreshnessSchema = z.object({
  verdict: repositoryFreshnessVerdictSchema,
  /** 产物生成时间（`analysis.generatedAt`），界面据此说「这是几天前的分析」 */
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
  /** 目录还在吗（不存在时保留条目并如实标注，由用户决定移除） */
  exists: z.boolean(),
  /** 产物是否已就绪（`.tutor/tutor.db` 里四件套齐不齐）；未挂载时不探测 */
  artifactsReady: z.boolean().optional(),
  freshness: repositoryFreshnessSchema.optional(),
  /**
    增量监听此刻活着吗（只挂着的仓有值）。false = 这个仓不会自动跟上磁盘改动，
    上面那份 `freshness` 只到挂载那一刻为止——不报这条，界面就会一直拿一次旧判定说「产物是新的」。
  */
  watching: z.boolean().optional(),
  /** 监听起不来或中途死掉的报错原文，配合 `watching: false` 看 */
  watchError: z.string().optional(),
  /**
    监听是不是被人为挂起的（编辑期免打扰）。必须与 `watching: false` 分开：同为「不会自动跟上磁盘」，
    但一个是引擎坏了要修，另一个是用户按下的、到点会自己恢复的开关。
  */
  watchPaused: z.boolean().optional(),
  /** 挂起到什么时候（ISO 串）；到点自动恢复并重算一次新鲜度 */
  watchPausedUntil: z.string().optional(),
  /**
    预算闸门此刻是否失效（只在失效时有值）。挂在地址簿而不是等用户进了仓才在成本页说：
    单价没配 ⇒ 闸门判不出超支 ⇒ 下一次导入就是在无上限花钱，这句话必须出现在花钱之前那页。
  */
  budgetGateNotice: z.string().optional()
});
export type RepositoryCatalogEntry = z.infer<typeof repositoryCatalogEntrySchema>;

/** 懒挂载失败的原因：GUI 要靠它分清「清掉工作区」还是「留着让用户处置」。 */
export const repositoryMountReasonSchema = z.enum(["not_in_catalog", "directory_missing", "artifacts_incomplete"]);
export type RepositoryMountReason = z.infer<typeof repositoryMountReasonSchema>;

/* ------------------------------------------------------------------ */
/* 会话线程                                                            */
/* ------------------------------------------------------------------ */

export const chatScopeSchema = z.enum(["teach", "map", "practice"]);
export type ChatScope = z.infer<typeof chatScopeSchema>;

/** 一个对话线程的头（正文在 chat_message；软删只体现在 `deletedAt`，列表读侧过滤）。 */
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

/** 线程里的一条消息：`error` 非空表示这轮失败（失败也入库，GUI 才能重现「当时报错」的气泡）。 */
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
  /** true = 命中价没单独配置，按输入价计（不打折的理由见 engine `cost/cost.ts` 的 `Pricing` 注释，不在此复述） */
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

/** 按自然日聚合的用量（取 journal `at` 的前 10 位），画近期条形用。 */
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
  /**
    false = 三档单价全未配置 ⇒ 金额恒 0、`mode` 恒为 "normal"——预算闸门根本没在管事，不是「没超预算」。
    界面必须把这个节点说成「预算闸门未生效」，不能只报 ¥0.0000。判据在 engine `cost/cost.ts`（`pricingIsConfigured`）。
  */
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

/** 回合场景名：三条作用域对话流共用，与 journal 的 `scene`、引擎回合登记表同一套词。 */
export const turnSceneSchema = z.enum(["teach", "map_chat", "practice_chat"]);
export type TurnScene = z.infer<typeof turnSceneSchema>;

/**
  教学回合的过程提示（`{stage}` 形状）：引擎 `harness` 发它，文案由界面定（引擎不关心中文措辞，界面不猜阶段语义）。
  读文件、检索、取技能、改图、查产物、打外部程序各成一档——没有帧的活动在界面上就是「没发生过」，用户只会看到一串「正在思考」。
  思考不带轮数：轮数是引擎自己的成本读数（journal 的 `loop_round`），不是给用户看的进度。
  */
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
  作用域对话流（三处 per-request SSE）的过程帧与正文帧词表。这是引擎与界面之间的唯一词表：
  - 引擎要发新的一类帧，必须先加进这里（`server.ts` 的 `send` 按这份联合类型收，编不出没登记的帧）；
  - 界面的映射带穷尽守卫（`never` 断言），漏接一类直接编译不过；
  - 界面在每一帧上跑这份 schema，形状不对就当场抛，不会让「正在检索…」永远挂着。

  刻意不含 `done` 的成品载荷：三条流的 done 形状各不相同（teach 带 session/policy/cost，map 带 diagram），
  那部分仍由各自的返回体声明；这里只锁过程帧的种类与形状。
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
  全局事件流（`GET /api/events`）的广播事件：导入进度与仓库更新。对话的 delta/progress 不走这里——
  它们在各自请求的响应流里。
  - `repository.updated`：产物或覆盖层变了，界面该重取的那个节点；
  - `diagram_updated`：画布上的一张图变了（agent 画完 / 结构改动 / 改名 / 删除 / 恢复）。
  界面据此重取图库与当前图——几何拖动不广播，那是用户自己正在拖的东西，再推一帧给他就是抢鼠标。
*/
export const serverEventSchema = z.object({
  type: z.enum(["import.progress", "repository.updated", "diagram_updated"]),
  payload: z.record(z.string(), z.unknown())
});
export type ServerEvent = z.infer<typeof serverEventSchema>;

/* ------------------------------------------------------------------ */
/* 边界上的校验口                                                      */
/* ------------------------------------------------------------------ */

/**
  一次契约失败：带得上「哪个契约、哪一格、引擎给的是什么」。
  契约分歧的表现是界面上一个 `undefined`，这里把它变成一次带路径的异常，能在控制台与错误气泡里读出来。
*/
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
