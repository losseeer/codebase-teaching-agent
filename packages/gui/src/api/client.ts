import {
  checkContract,
  chatThreadMessageSchema,
  chatThreadSchema,
  costSummarySchema,
  importJobSchema,
  repositoryCatalogEntrySchema,
  scopedStreamProgressSchema,
  serverEventSchema,
  type ChatScope,
  type CostSummary,
  type ImportJob,
  type RepositoryCatalogEntry,
  type RepositoryFreshness,
  type RepositoryMountReason,
  type ScopedStreamProgress,
  type ServerEvent
} from "@codebase-tutor/contract";
import {
  type DiagramSummary,
  type Exercise,
  type ExerciseAnswer,
  type ExerciseKind,
  type ExerciseResult,
  type FadedState,
  type LearnerProfile,
  type PracticeSummary,
  type RepositoryIndex,
  type TutorSession,
  type TutorSettings,
  type Diagram
} from "@codebase-tutor/domain";
export type { RepositoryCatalogEntry, RepositoryFreshness, ScopedStreamProgress } from "@codebase-tutor/contract";

import {z, type ZodType } from "zod";

/**
 * 当前激活的工作区：被学习的仓库 ID 与路径。所有视图（宏观设计 / 代码教学 / 练习评估 / 成本监控）
 * 都以这个 workspace 为锚点。Agent 侧栏与各视图的 localStorage 偏好也按 repositoryId 持久化。
 */
export interface Workspace {
  repositoryId: string;
  repositoryPath: string;
}

// 形状来自 shared，这里转发一次，视图层统一从 api/client 取类型。

/**
  作用域对话流的过程帧词表来自 `shared`（引擎的 `send` 也按同一份类型收）。
  种类由 shared 定，守卫点是下面的 `toScopedEvent`。
*/

/**
  一帧原始 JSON → 词表里的过程帧：先过 shared 的契约（种类与形状都在那里定），再逐字段兜一下形状。
  导出是为了这条边界能被单独测。
  */
export function parseScopedStreamFrame(raw: unknown): ScopedStreamProgress {
  return toScopedEvent(checkContract(scopedStreamProgressSchema, raw, "stream.progress"));
}

/**
  契约过了之后的一份窄化：种类已由 schema 锁死，这里只剩「缺字段给兜底值」，并穷尽这张表——
  shared 里新增一类而这里没接，`default` 上的 `never` 断言就编译不过。
*/
function toScopedEvent(event: ScopedStreamProgress): ScopedStreamProgress {
  switch (event.type) {
    case "thinking": return { type: "thinking" };
    case "reading": return { type: "reading", path: String(event.path ?? "") };
    case "searching": return { type: "searching", query: String(event.query ?? "") };
    case "loading_skill": return { type: "loading_skill", skill: String(event.skill ?? "") };
    case "editing_diagram": return { type: "editing_diagram" };
    case "querying_facts": return { type: "querying_facts" };
    case "calling_external": return { type: "calling_external" };
    case "progress": return { type: "progress", payload: event.payload };
    case "delta": return { type: "delta", delta: String(event.delta ?? "") };
    default: {
      const unhandled: never = event;
      throw new Error(`未登记的过程帧：${JSON.stringify(unhandled)}`);
    }
  }
}

/** 一次流式回合的客户端句柄：`turnId` 让引擎能按 id 中止在途的那一轮，`signal` 中止自己的连接。
    两者要分开用——只断连接引擎分不清「用户点停止」和「网络波动」，它会照常把这一轮算完并落库（断线补账靠这个）。 */
/**
  宏观设计回合 done 帧的两种形状：正常成品（`reply`）与被中断（`interrupted`，没有成品）。
  写成判别联合而不是把所有格都可选，是因为「空回复」与「这一轮没有回复」是两件事——
  后者要让界面出 warn 条和重试入口，前者会被当成一句空话落进线程。
*/
export type MapDoneFrame =
  | { reply: string; provider: string; diagram?: { id: string; name: string }; asked?: { toolCallId: string; facet: string; question: string; options: string[] }; interrupted?: undefined }
  | { reply?: undefined; provider: string; diagram?: { id: string; name: string }; asked?: undefined; interrupted: { reason: string; detail: string } };

export interface StreamTurn {
  turnId?: string;
  signal?: AbortSignal;
}

/** 全站通用 SSE 读取：POST → 逐过程帧回调 → done 事件固化为返回值；error 与普通 HTTP 错误统一抛 Error，aborted 不做的事由调用方收尾。 */
async function sseStream<TDone>(url: string, payload: unknown, onEvent: (event: ScopedStreamProgress) => void, signal?: AbortSignal): Promise<TDone> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), ...(signal ? { signal } : {}) });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({ error: "请求失败" })) as { error?: string };
    throw new Error(body.error ?? "请求失败");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: TDone | undefined;
  const consume = (chunk: string): void => {
    const line = chunk.startsWith("data: ") ? chunk.slice(6) : "";
    if (!line) return;
    const event = JSON.parse(line) as Record<string, unknown> & { type: string };
    if (event.type === "error") throw new Error(String(event.error ?? "LLM 对话失败"));
    if (event.type === "done") {
      final = event as TDone;
      return;
    }
    // 中止帧这里不做事：点「停止」那一侧本来就知道自己停了，本地收尾比等一帧可靠（引擎发这一帧是给自己记账的）
    if (event.type === "aborted") return;
    // 过程帧逐帧过契约：形状不符当场抛
    onEvent(parseScopedStreamFrame(event));
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (!final) throw new Error("连接中断，未收到完整回复");
  return final;
}

/** LLM 运行时设置（GUI 可改，引擎落盘持久，重启后仍在；留空项回落 .env）。 */
export type ThinkingEffort = "auto" | "off" | "low" | "high" | "max";

/** 服务商协议，与引擎 llm/runtime.ts 的 LLM_PROVIDERS 一致；空串 = 用 .env 的 TUTOR_LLM_PROVIDER。 */
export type LlmProviderKind = "openai-compatible" | "openai";

/** 模型思考能力声明（引擎按模型 slug 查表解析，见 engine llm/thinking.ts）。efforts 为该模型支持的显式档位（auto 恒可用）。 */
export interface ThinkingCapabilityInfo {
  model: string;
  style: "deepseek" | "openai" | "anthropic" | "none" | "unknown";
  efforts: Exclude<ThinkingEffort, "auto">[];
}

/** .env 侧的回落口径（引擎解析一次下发）：GUI 用它把空字段说明成「留空 = 用 .env 的 xxx」。 */
export interface LlmEnvFallback {
  provider: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  /** .env 那一份解析完的超时（毫秒）：留空时实际生效的就是它，界面上要能说出来。 */
  timeoutMs?: number;
}

/**
  单价某一档的来源：`runtime` = LLM 配置框里填的，`env` = `.env` 的值，`unset` = 两层都没配。
  界面上必须说清来源。
  */
export type PricingSource = "runtime" | "env" | "unset";

export interface LlmSettings {
  /** 运行时服务商覆盖（空串 = 用 .env；取值为 LlmProviderKind 之一） */
  provider: string;
  /** 运行时模型覆盖（空串 = 用 .env 配置）；轻任务/教学对话共用这一套配置 */
  model: string;
  baseUrl: string;
  thinking: ThinkingEffort;
  /** 运行时密钥只以掩码出现——引擎从不回显明文 */
  apiKeyMasked: string;
  hasApiKey: boolean;
  envFallback: LlmEnvFallback;
  thinkingCapability?: ThinkingCapabilityInfo;
  /**
    单价三档的填写值（空串 = 这一档交给 .env），口径是人民币 / 百万 token。
    字段名与 `.env` 的 `TUTOR_*_USD_PER_MILLION` 同名同义，名字里的 USD 不代表美元。
    */
  inputUsdPerMillion?: string;
  outputUsdPerMillion?: string;
  cacheHitUsdPerMillion?: string;
  /** 单次请求的超时（毫秒，空串 = 用 .env）；`activeTimeoutMs` 是现在真生效的那一份。 */
  timeoutMs?: string;
  activeTimeoutMs?: number;
  timeoutRange?: { minMs: number; maxMs: number };
  /** 现在真在用的三档（人民币 / 百万 token；引擎每次算账现读，改完不用重启） */
  pricing?: { inputPerMillionUsd: number; cacheHitPerMillionUsd?: number; outputPerMillionUsd: number };
  /** 每一档由谁给出：填过 = runtime，否则 .env，两层都没有 = unset */
  pricingSources?: { input: PricingSource; output: PricingSource; cacheHit: PricingSource };
  /** 当前实际生效的 provider/模型/模式（local = 没配齐或密钥缺失：对话与 LLM 出题在发请求前被拒） */
  activeModel?: string;
  activeProvider?: string;
  activeMode?: "remote" | "local";
}

/** PUT 的部分更新：省略 = 保持不变，空串 = 清除该项并回落 .env（apiKey 为空串即删除已存密钥）。 */
export type LlmSettingsPatch = Partial<{
  provider: LlmProviderKind | "";
  model: string;
  baseUrl: string;
  apiKey: string;
  thinking: ThinkingEffort;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  cacheHitUsdPerMillion: string;
  timeoutMs: string;
}>;

/** 带状态码的 HTTP 失败：调用方要区分「404 = 东西真没有」和「连不上 / 5xx = 引擎暂时不在」，两者的用户处置完全不同。
    仓库类 404 还带 `reason`（不在地址簿 / 目录没了 / 产物不全）——只有第一种该清掉本地工作区，另两种要留着让用户处置。 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: RepositoryMountReason) {
    super(message);
    this.name = "ApiError";
  }
}

export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

async function requestRaw(path: string, init?: RequestInit): Promise<unknown> {
  // 只有带 body 的请求才声明 JSON Content-Type：Fastify 见到「application/json + 空 body」会 400 拒掉，无体的 DELETE 就是这么被打回的。
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const body = await response.json() as { error?: string; reason?: RepositoryMountReason };
  if (!response.ok) throw new ApiError(response.status, body.error ?? "请求失败", body.reason);
  return body;
}

/**
  没套契约的端点走这条：编译期声明 + 一次 `as`。
  热路径（地址簿、导入任务、成本、会话线程、两条事件流）已改走 `checked()`，新端点优先用 `checked()`。
  */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestRaw(path, init)) as T;
}

/**
  边界上真校验的一条路：引擎给的东西不符契约就抛 `ContractViolation`（带格名），
  而不是让 `undefined` 一路画上屏、界面停在半个状态也不报错。
  `name` 用节点名（`catalog` / `import` / `cost`…），报出来就读得出是哪个端点变了形状。
  */
async function checked<T>(name: string, schema: ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  return checkContract(schema, await requestRaw(path, init), name);
}

/**
  画图工作区（`/diagrams`）的两条线上形状。

  - `DiagramPosition`：拖动落盘只带坐标，结构一个字段都不碰；
  - `DiagramWarning`：读侧的诚实检查——图上某个模块节点的 `ref` 在现在的索引里查不到了（改名、删文件或重分析过）。
    引擎发的是节点 id + 一句原因，界面据此把那个节点标成失效，不当活节点画。
*/
export interface DiagramPosition {
  id: string;
  x: number;
  y: number;
}

export interface DiagramWarning {
  node: string;
  reason: string;
}

/**
  画布那格保存状态（界面自己的读数，不是引擎的字段）。
  `synced`（刚从盘上取下来、还没动过）与 `saved`（真写过一次几何）都表示「画布 = 盘上那份」；
  `queued` 是拖动结束、去抖还没到；`saving` 是在途；`failed` 必须显形，不替一次失败的写入说「已保存」。
*/
export type SaveState = "synced" | "queued" | "saving" | "saved" | "failed";

export const api = {
  getLlmSettings: () => request<LlmSettings>("/api/llm/settings"),
  updateLlmSettings: (partial: LlmSettingsPatch) => request<LlmSettings>("/api/llm/settings", { method: "PUT", body: JSON.stringify(partial) }),
  submitImport: (path: string, summaryHeaderComments?: boolean) => request<ImportJob>("/api/imports", { method: "POST", body: JSON.stringify({ path, ...(summaryHeaderComments === undefined ? {} : { summaryHeaderComments }) }) }),
  getImport: (jobId: string) => checked<ImportJob>("import", importJobSchema, `/api/imports/${jobId}`),
  /** 引擎的地址簿（用户导过的仓）：只列不读产物，所以打开切换器很便宜。 */
  listRepositories: () => checked("repositories", z.object({ repositories: z.array(repositoryCatalogEntrySchema) }), "/api/repositories"),
  /** 显式挂载一个仓库并拿到新鲜度判定；不在地址簿/目录没了/产物不全都按 reason 抛错。 */
  mountRepository: (repositoryId: string) => request<{ repositoryId: string; repositoryPath: string; freshness: RepositoryFreshness }>(`/api/repositories/${repositoryId}/mount`, { method: "POST" }),
  /** 把仓库移出地址簿（只动引擎的登记，不碰仓库里的 .tutor/）。 */
  forgetRepository: (repositoryId: string, artifacts = false) => request<{ repositories: RepositoryCatalogEntry[]; artifacts?: "removed" | "absent" | "refused" }>(`/api/repositories/${repositoryId}${artifacts ? "?artifacts=1" : ""}`, { method: "DELETE" }),
  getIndex: (repositoryId: string) => request<RepositoryIndex>(`/api/repositories/${repositoryId}/index`),
  /** 导入完成后的报告：索引概况 + 本次 token/金额估算。 */
  getReport: (repositoryId: string) => request<{ index: RepositoryIndex; estimate: { cachedFiles: number; summarizedFiles: number; estimatedInputTokens: number; estimatedCostUsd: number; provider: string } }>(`/api/repositories/${repositoryId}/report`),
  /** 教学/练习两侧的锚点行读数：按文件路径取那份实时源码。 */
  getSource: (repositoryId: string, path: string, line: number) => request<{ path: string; line: number; content: string }>(`/api/repositories/${repositoryId}/source?path=${encodeURIComponent(path)}&line=${line}`),
  /* ---- 画图工作区（宏观设计）：七条路由全部免费——只读/写库里的图元，一次都不碰模型。
     这里故意没有「加节点 / 删节点 / 改边」那种面向界面的结构写入口：结构改动只有 agent 的
     `set_diagram` 一条路（引擎侧白名单），界面提供拖动（几何）与改名，别的一律不给。
     新增图 = 一张空白画布（`source:"me"`），它同样只能靠对话往里画东西。 ---- */
  /** 图库列表：只有摘要（节点/边/版本计数），不把整张结构拖进左栏。 */
  listDiagrams: (repositoryId: string) => request<{ diagrams: DiagramSummary[] }>(`/api/repositories/${repositoryId}/diagrams`),
  /** 新建一张空白图（名字省略则由引擎起「未命名图」并去重）。 */
  createDiagram: (repositoryId: string, name?: string) => request<{ diagram: Diagram }>(`/api/repositories/${repositoryId}/diagrams`, { method: "POST", body: JSON.stringify(name ? { name } : {}) }),
  /** 打开一张图：`warnings` 是读侧的失效检查（`ref` 已经不在索引里的节点）。 */
  getDiagram: (repositoryId: string, diagramId: string) => request<{ diagram: Diagram; warnings: DiagramWarning[]; filesByNode: Record<string, { path: string; line: number }[]> }>(`/api/repositories/${repositoryId}/diagrams/${encodeURIComponent(diagramId)}`),
  renameDiagram: (repositoryId: string, diagramId: string, name: string) => request<{ diagram: Diagram }>(`/api/repositories/${repositoryId}/diagrams/${encodeURIComponent(diagramId)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteDiagram: (repositoryId: string, diagramId: string) => request<{ deleted: boolean; diagramId: string }>(`/api/repositories/${repositoryId}/diagrams/${encodeURIComponent(diagramId)}`, { method: "DELETE" }),
  /** 几何落盘：拖动结束后只送变化过的位置。存的是位置，不产生版本（版本只由 agent 的结构改动留下）。 */
  saveDiagramGeometry: (repositoryId: string, diagramId: string, positions: DiagramPosition[]) => request<{ diagram: Diagram }>(`/api/repositories/${repositoryId}/diagrams/${encodeURIComponent(diagramId)}/geometry`, { method: "PUT", body: JSON.stringify({ positions }) }),
  /** 回到某一版快照（`index` 按 `versions` 数组下标，旧→新）。引擎会把恢复后的样子再存一版，历史不截断。 */
  restoreDiagram: (repositoryId: string, diagramId: string, index: number) => request<{ diagram: Diagram }>(`/api/repositories/${repositoryId}/diagrams/${encodeURIComponent(diagramId)}/restore`, { method: "POST", body: JSON.stringify({ index }) }),
  /** 浏览器本地遗留覆盖层的一次性上报。 */
  getPractice: (repositoryId: string) => request<PracticeSummary>(`/api/repositories/${repositoryId}/practice`),
  getLearner: (repositoryId: string) => request<LearnerProfile>(`/api/repositories/${repositoryId}/learner`),
  createExercise: (repositoryId: string, options: { kind?: ExerciseKind; targetUnitId?: string; family?: "comprehension" | "llm"; tag?: string; tagId?: string; variantNonce?: number } = {}) => request<Exercise>(`/api/repositories/${repositoryId}/exercises`, { method: "POST", body: JSON.stringify(options) }),
  submitExercise: (repositoryId: string, exerciseId: string, answer: ExerciseAnswer) => request<ExerciseResult>(`/api/repositories/${repositoryId}/exercises/${encodeURIComponent(exerciseId)}/answer`, { method: "POST", body: JSON.stringify(answer) }),
  /** 代码题的按需讲评：判完之后点一次才发这一趟（默认不花钱，见 engine `exercises/explain`）。 */
  explainExercise: (repositoryId: string, exerciseId: string, answer: ExerciseAnswer) => request<{ explanation: string }>(`/api/repositories/${repositoryId}/exercises/${encodeURIComponent(exerciseId)}/explain`, { method: "POST", body: JSON.stringify(answer) }),
  getCost: (repositoryId: string, sessionId?: string) => checked<CostSummary>("cost", costSummarySchema, `/api/repositories/${repositoryId}/cost${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  setBudget: (repositoryId: string, monthlyBudgetUsd: number) => checked<CostSummary>("budget", costSummarySchema, `/api/repositories/${repositoryId}/settings`, { method: "PUT", body: JSON.stringify({ monthlyBudgetUsd }) }),
  createSession: (repositoryId: string, scopeRef: string, settings?: TutorSettings) => request<{ session: TutorSession; recommendedSettings: LearnerProfile["recommended"]; faded: FadedState }>("/api/sessions", { method: "POST", body: JSON.stringify({ repositoryId, scopeRef, ...(settings ? { settings } : {}) }) }),
  /** 按 id 取教学会话：内存未命中时引擎从 chat_session（含状态快照）+ chat_message 重建。 */
  getSession: (sessionId: string) => request<TutorSession>(`/api/sessions/${encodeURIComponent(sessionId)}`),
  /**
    会话线程（产品线真源在引擎的 chat_session / chat_message）：三作用域各一份独立列表。
    删除是软删——列表与正文从此看不见，行仍在库里；journal 另记一条 session_deleted。
    */
  /** 会话清单：`threads` 只含已有对话记录的会话；`current` 回认界面正打开着的那条（还没发言也认，删了才回 null）。 */
  listThreads: (repositoryId: string, scope: ChatScope, current?: string) => checked("threads", z.object({ threads: z.array(chatThreadSchema), current: chatThreadSchema.nullable() }), `/api/repositories/${repositoryId}/threads?scope=${scope}${current ? `&current=${encodeURIComponent(current)}` : ""}`),
  createThread: (repositoryId: string, payload: { scope: ChatScope; scopeRef?: string; exerciseId?: string; title?: string }) => checked("thread", z.object({ thread: chatThreadSchema }), `/api/repositories/${repositoryId}/threads`, { method: "POST", body: JSON.stringify(payload) }),
  getThreadMessages: (threadId: string) => checked("threadMessages", z.object({ thread: chatThreadSchema, messages: z.array(chatThreadMessageSchema) }), `/api/threads/${encodeURIComponent(threadId)}/messages`),
  renameThread: (threadId: string, title: string) => checked("thread", z.object({ thread: chatThreadSchema }), `/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteThread: (threadId: string) => checked("threadDelete", z.object({ deleted: z.boolean(), threadId: z.string() }), `/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" }),
  /** 教学回合流式版：SSE 逐事件回调过程提示（progress）与正文增量（delta），resolve 于 done（session/message/cost/provider）。会话或节点失效仍是普通 JSON。 */
  sendMessageStream: (sessionId: string, content: string, settings: TutorSettings, onEvent: (event: ScopedStreamProgress) => void, turn: StreamTurn = {}) =>
    sseStream<{ session: TutorSession; message: { content: string }; cost: CostSummary; provider: string }>(
      `/api/sessions/${sessionId}/messages`,
      { content, settings, ...(turn.turnId ? { turnId: turn.turnId } : {}) },
      onEvent,
      turn.signal
    ),
  /** map-chat 流式版：SSE 逐事件回调过程帧（词表见 `shared` 的 `scopedStreamProgressSchema`）与正文增量（delta），resolve 于 done（回复、来源模型、这一回合真画/真改了哪张图、以及这一回合是否在向用户提问）。
      `diagramId` = 画布上正打开的那张图，agent 的结构改动按这一格定，认不出就不动——所以这一格必须由界面送当下真实打开的那张。
      done 有两种形状：正常成品带 `reply`；被中断的那一轮没有成品，只有 `interrupted`（界面据此出 warn 条与重试，不能拿空串冒充回复）。 */
  mapChatStream: (repositoryId: string, payload: { content: string; scopePaths?: string[]; path?: string; threadId?: string; diagramId?: string; style: number; resumeAsk?: string }, onEvent: (event: ScopedStreamProgress) => void, turn: StreamTurn = {}) =>
    sseStream<MapDoneFrame>(`/api/repositories/${repositoryId}/map-chat/stream`, { ...payload, ...(turn.turnId ? { turnId: turn.turnId } : {}) }, onEvent, turn.signal),
  /** 练习追问：与 map-chat 同款 SSE（done/error/delta）；线程无效是 409、练习或仓库失效是 404，都走普通 JSON。
      `diagram? / asked? / interrupted?: undefined`：练习作用域既没有画图工具也没有提问与中断那一档，这几格恒不出现——两条流的 done 形状对齐，
      调用方（`useScopedChat` 的 sendScoped）合成一个变量读时不必再分岔。 */
  practiceChat: (repositoryId: string, payload: { content: string; exerciseId: string; threadId?: string; style: number }, onEvent: (event: ScopedStreamProgress) => void, turn: StreamTurn = {}) =>
    sseStream<{ reply: string; provider: string; diagram?: undefined; asked?: undefined; interrupted?: undefined }>(`/api/repositories/${repositoryId}/practice-chat`, { ...payload, ...(turn.turnId ? { turnId: turn.turnId } : {}) }, onEvent, turn.signal),
  /** 「停止生成」的带外通知：告诉引擎这一轮不要算了。404 = 那一轮已经结束，对界面来说同样是「停下来了」，所以调用方丢弃错误即可。 */
  stopTurn: (turnId: string) => request<{ stopped: boolean }>("/api/turns/stop", { method: "POST", body: JSON.stringify({ turnId }) })
};

/**
  全局事件流（`GET /api/events`，导入进度与仓库更新）。用 fetch 读流，与三条对话流共用同一套读流、退避与 abort 语义。
  重连自己管：指数退避 1s→2s→4s→8s→16s，20s 封顶，一旦成功建立连接就清零；`AbortSignal` 用来在依赖变化 / 卸载时
  彻底停下（含正在退避的那一次等待）。注释帧（`: open` / `: ping`）在这里被 `data: ` 那一条筛掉——引擎开局就发
  一帧把响应头推到网路上，所以 `fetch` 立刻 resolve，连接状态在开局就能确认。
  空闲看门狗：引擎死了但中间的代理 / 反代还替它挂着这条连接时，`reader.read()` 既不 resolve 也不 reject，
  退避重连永远不会被触发（表现为「界面停在 40% 不动，而引擎其实早就没了」）。
  阈值 75s（引擎每 25s 一帧心跳，等于容忍连丢三帧）；超时只中止这一次尝试再按退避重连，不作废整条订阅。
  */
const STREAM_IDLE_MS = 75_000;

export function subscribeServerEvents(onEvent: (event: ServerEvent) => void, signal?: AbortSignal): () => void {
  const controller = new AbortController();
  let stopped = false;
  const abortBoth = (): void => { stopped = true; controller.abort(); };
  signal?.addEventListener("abort", abortBoth, { once: true });

  const delay = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    controller.signal.addEventListener("abort", () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });

  void (async () => {
    let failures = 0;
    while (!stopped && !controller.signal.aborted) {
      // 每一次尝试单独一个 controller：空闲超时只掐这一条连接，长命的那个留给真正的「别再订阅了」
      const attempt = new AbortController();
      const relayAbort = (): void => attempt.abort();
      controller.signal.addEventListener("abort", relayAbort);
      try {
        const response = await fetch("/api/events", { signal: attempt.signal });
        if (!response.ok || !response.body) {
          throw new Error(`事件流建立失败（HTTP ${String(response.status)}）`);
        }
        failures = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          let idleTimer = 0;
          const idle = new Promise<never>((_, reject) => { idleTimer = window.setTimeout(() => reject(new Error("事件流空闲超时")), STREAM_IDLE_MS); });
          let chunk;
          try {
            chunk = await Promise.race([reader.read(), idle]);
          } finally {
            window.clearTimeout(idleTimer);
          }
          const { done, value } = chunk;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
            if (line) {
              try {
                // 契约不符走下面这条 catch：一条坏帧只跳过、不断流，但也不能当没看见
                onEvent(checkContract(serverEventSchema, JSON.parse(line.slice(6)), "events"));
              } catch (error) {
                console.error("[gui] 事件流有一帧不符契约，已跳过：", error instanceof Error ? error.message : error);
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // 空闲超时走的就是这一支：中止这一次尝试，下面按同一份退避重连
        attempt.abort();
        if (stopped || controller.signal.aborted) break;
      } finally {
        controller.signal.removeEventListener("abort", relayAbort);
      }
      if (stopped || controller.signal.aborted) break;
      // 服务端正常收尾也会走到这里（连接被关）：按同一份退避重来，不留「看着连着其实没订阅」的状态
      await delay(Math.min(1_000 * 2 ** failures++, 20_000));
    }
  })();

  return abortBoth;
}
