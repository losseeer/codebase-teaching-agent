import type { ArchitectureOverrideIntent, ArchitecturePlan, RepositoryOverlays,  ChatScope, ChatThread, ChatThreadMessage, CostSummary, CourseNodeDetail, CourseNodePage, CourseTree, Exercise, ExerciseAnswer, ExerciseKind, ExerciseResult, FadedState, FlowStage, ImportEstimate, ImportJob, ImpactResult, LearnerProfile, PracticeSummary, RepositoryAnalysis, RepositoryCatalogEntry, RepositoryFlowResult, RepositoryFreshness, RepositoryIndex, RepositoryMountReason, RepositoryOverview, ServerEvent, SuggestedEntry, TutorSession, TutorSettings } from "@codebase-tutor/shared";

/**
 * 当前激活的工作区：被学习的仓库 ID 与路径。所有视图（宏观设计 / 代码教学 / 练习评估 / 成本监控）
 * 都以这个 workspace 为锚点。Agent 侧栏与各视图的 localStorage 偏好也按 repositoryId 持久化。
 *
 * 对应 prototype `design-prototype.html` 中的 `binds[scope]` 概念。
 */
export interface Workspace {
  repositoryId: string;
  repositoryPath: string;
}

// 地址簿与新鲜度的形状来自 shared，这里转发一次，视图层统一从 api/client 取类型（与 Workspace 同例）。
export type { RepositoryCatalogEntry, RepositoryFreshness } from "@codebase-tutor/shared";

/** 作用域对话 SSE 事件：thinking / reading / searching 是过程指示，delta 是正文增量（打字机回放），done/error 收尾。 */
export type ScopedChatEvent =
  | { type: "thinking"; round: number }
  | { type: "reading"; path: string }
  | { type: "searching"; query: string }
  | { type: "delta"; delta: string };

/** 教学回合 SSE 事件：progress 是过程提示（判断动作 / 读文件 / 检索代码），delta 是正文增量；done 由 sendMessageStream 的返回值固化。 */
export type TeachingStreamEvent =
  | { type: "progress"; payload: { stage?: string; round?: number; path?: string; query?: string } }
  | { type: "delta"; delta: string };

/** 一次流式回合的客户端句柄：`turnId` 让引擎能按 id 中止在途的那一轮，`signal` 掐掉自己的连接。
    两者要分开用——只断连接引擎分不清「用户点停止」和「网络波动」，它会照常把这一轮算完并落库（断线补账靠这个）。 */
export interface StreamTurn {
  turnId?: string;
  signal?: AbortSignal;
}

/** 全站通用 SSE 读取：POST → 逐事件回调 → done 事件固化为返回值；error 事件与普通 HTTP 错误统一抛 Error。 */
async function sseStream<TDone>(url: string, payload: unknown, onEvent: (event: Record<string, unknown> & { type: string }) => void, signal?: AbortSignal): Promise<TDone> {
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
    onEvent(event);
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

/**
  宏观设计与练习追问共用的过程帧映射（四条对话流里这两条同形）。
  练习作用域压根不发 `searching`（它没有检索工具），这张表照旧认它——多认一类不会凭空生出事件，
  少认一类就会让「正在检索…」在界面上永远停在「回复生成中…」（10-06 就是这么发现 thinking 漏接的）。
*/
function mapScopedEvent(event: Record<string, unknown> & { type: string }, onEvent: (event: ScopedChatEvent) => void): void {
  if (event.type === "thinking") onEvent({ type: "thinking", round: Number(event.round ?? 1) });
  else if (event.type === "reading") onEvent({ type: "reading", path: String(event.path ?? "") });
  else if (event.type === "searching") onEvent({ type: "searching", query: String(event.query ?? "") });
  else if (event.type === "delta") onEvent({ type: "delta", delta: String(event.delta ?? "") });
}

/** LLM 运行时设置（GUI 可改，引擎落盘持久，重启后仍在；留空项回落 .env）。 */
export type ThinkingEffort = "auto" | "off" | "low" | "high" | "max";

/** 服务商协议，与引擎 llm/runtime.ts 的 LLM_PROVIDERS 一致；空串 = 用 .env 的 TUTOR_LLM_PROVIDER。 */
export type LlmProviderKind = "openai-compatible" | "openai" | "anthropic" | "ollama";

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
}

/**
  单价某一档的来源：`runtime` = LLM 配置框里填的，`env` = `.env` 的值，`unset` = 两层都没配。
  界面上必须说清来源——留空那格显示的是 .env 的数，不写来源就会变成「我明明填了怎么没变」。
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
  presets: string[];
  envFallback: LlmEnvFallback;
  thinkingCapability?: ThinkingCapabilityInfo;
  /**
    单价三档的**填写值**（空串 = 这一档交给 .env）。数值口径是**人民币 / 百万 token**，
    与 `.env` 的 `TUTOR_*_USD_PER_MILLION` 同一格——变量名里的 USD 是历史遗留（改名会牵动已落盘的配置），
    引擎侧不做任何汇率换算，填什么币就显示什么币。
    */
  inputUsdPerMillion?: string;
  outputUsdPerMillion?: string;
  cacheHitUsdPerMillion?: string;
  /** 现在真在用的三档（人民币 / 百万 token；引擎每次算账现读，改完不用重启） */
  pricing?: { inputPerMillionUsd: number; cacheHitPerMillionUsd?: number; outputPerMillionUsd: number };
  /** 每一档由谁给出：填过 = runtime，否则 .env，两层都没有 = unset（闸门不管事） */
  pricingSources?: { input: PricingSource; output: PricingSource; cacheHit: PricingSource };
  /** 当前实际生效的 provider/模型/模式（local = 没配齐或密钥缺失，走本地启发式） */
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 只有带 body 的请求才声明 JSON Content-Type：Fastify 见到「application/json + 空 body」会 400 拒掉，无体的 DELETE 就是这么被打回的。
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const body = await response.json() as T & { error?: string; reason?: RepositoryMountReason };
  if (!response.ok) throw new ApiError(response.status, body.error ?? "请求失败", body.reason);
  return body;
}

export const api = {
  /** 探活：认证闸已撤除（§64），这一格不再有 `auth` 读数；沙箱闸门状态仍然如实报。 */
  health: () => request<{ status: string; llmMode?: string; sandbox?: { level: string } }>("/api/health"),
  getLlmSettings: () => request<LlmSettings>("/api/llm/settings"),
  updateLlmSettings: (partial: LlmSettingsPatch) => request<LlmSettings>("/api/llm/settings", { method: "PUT", body: JSON.stringify(partial) }),
  submitImport: (path: string, summaryHeaderComments?: boolean) => request<ImportJob>("/api/imports", { method: "POST", body: JSON.stringify({ path, ...(summaryHeaderComments === undefined ? {} : { summaryHeaderComments }) }) }),
  getImport: (jobId: string) => request<ImportJob>(`/api/imports/${jobId}`),
  /** 引擎的地址簿（用户导过的仓）：只列不读产物，所以打开切换器很便宜。 */
  listRepositories: () => request<{ repositories: RepositoryCatalogEntry[] }>("/api/repositories"),
  /** 显式挂载一个仓库并拿到新鲜度判定；不在地址簿/目录没了/产物不全都按 reason 抛错。 */
  mountRepository: (repositoryId: string) => request<{ repositoryId: string; repositoryPath: string; freshness: RepositoryFreshness }>(`/api/repositories/${repositoryId}/mount`, { method: "POST" }),
  /** 把仓库移出地址簿（只动引擎的登记，不碰仓库里的 .tutor/）。 */
  forgetRepository: (repositoryId: string) => request<{ repositories: RepositoryCatalogEntry[] }>(`/api/repositories/${repositoryId}`, { method: "DELETE" }),
  getIndex: (repositoryId: string) => request<RepositoryIndex>(`/api/repositories/${repositoryId}/index`),
  getCourse: (repositoryId: string) => request<CourseTree>(`/api/repositories/${repositoryId}/course`),
  getOverview: (repositoryId: string) => request<RepositoryOverview>(`/api/repositories/${repositoryId}/overview`),
  getCourseNodes: (repositoryId: string, parentId: string, offset = 0, limit = 30) => request<CourseNodePage>(`/api/repositories/${repositoryId}/course/nodes?parentId=${encodeURIComponent(parentId)}&offset=${offset}&limit=${limit}`),
  getCourseNodeDetail: (repositoryId: string, nodeId: string) => request<CourseNodeDetail>(`/api/repositories/${repositoryId}/analysis/node?nodeId=${encodeURIComponent(nodeId)}`),
  getAnalysis: (repositoryId: string) => request<RepositoryAnalysis>(`/api/repositories/${repositoryId}/analysis`),
  /** 导入前报告：索引概况 + 预估 token/金额 + 建议入口（ImportPage 在「花大钱之前」展示用）。 */
  getReport: (repositoryId: string) => request<{ index: RepositoryIndex; estimate: { cachedFiles: number; summarizedFiles: number; estimatedInputTokens: number; estimatedCostUsd: number; provider: string }; entrypoints: { title: string; anchors: { path: string; line: number }[] }[] }>(`/api/repositories/${repositoryId}/report`),
  getSource: (repositoryId: string, path: string, line: number) => request<{ path: string; line: number; content: string }>(`/api/repositories/${repositoryId}/source?path=${encodeURIComponent(path)}&line=${line}`),
  getImpact: (repositoryId: string, changedPaths: string[]) => request<ImpactResult>(`/api/repositories/${repositoryId}/impact`, { method: "POST", body: JSON.stringify({ changedPaths }) }),
  getModuleEntries: (repositoryId: string, moduleLabel: string, moduleHint?: string) => request<{ entries: SuggestedEntry[]; source: "llm" | "module_files"; reason?: string }>(`/api/repositories/${repositoryId}/module-entries?module=${encodeURIComponent(moduleLabel)}&hint=${encodeURIComponent(moduleHint ?? "")}`),
  /** 流程视图：按入口取一条 LLM 生成的执行流程；source=static 表示降级为静态调用链（reason 说明原因）。 */
  getRepositoryFlow: (repositoryId: string, entryPath: string) => request<RepositoryFlowResult>(`/api/repositories/${repositoryId}/flow?entry=${encodeURIComponent(entryPath)}`),
  /**
    架构视图的分层产物：层名与模块归层是模型判的（可人工改），箭头与「边界之外」由引擎算。
    `source` 与 `reason` 说清这份是谁算的；`ArchitecturePlan` 之外引擎多带两个读数。
  */
  getArchitecture: (repositoryId: string) => request<ArchitecturePlan & { omittedModules: number; collapsedExternals: number }>(`/api/repositories/${repositoryId}/architecture`),
  /** 显式重问一次分层：**花 token**，没配模型或预算触顶回 422（不静默给一张静态图）。 */
  regenerateArchitecture: (repositoryId: string) => request<ArchitecturePlan & { omittedModules: number; collapsedExternals: number }>(`/api/repositories/${repositoryId}/architecture/regenerate`, { method: "POST" }),
  getOverlays: (repositoryId: string) => request<{ overlays: RepositoryOverlays; counts: { modules: number; layers: number } }>(`/api/repositories/${repositoryId}/overlays`),
  /** 浏览器本地旧覆盖层的一次性上报（引擎此前完全不知道这些改动）。 */
  mergeOverlays: (repositoryId: string, overlays: RepositoryOverlays) => request<{ overlays: RepositoryOverlays; counts: { modules: number; layers: number } }>(`/api/repositories/${repositoryId}/overlays`, { method: "POST", body: JSON.stringify(overlays) }),
  getPractice: (repositoryId: string) => request<PracticeSummary>(`/api/repositories/${repositoryId}/practice`),
  getLearner: (repositoryId: string) => request<LearnerProfile>(`/api/repositories/${repositoryId}/learner`),
  createExercise: (repositoryId: string, options: { kind?: ExerciseKind; targetUnitId?: string; family?: "comprehension" | "llm"; tag?: string; tagId?: string; variantNonce?: number } = {}) => request<Exercise>(`/api/repositories/${repositoryId}/exercises`, { method: "POST", body: JSON.stringify(options) }),
  submitExercise: (repositoryId: string, exerciseId: string, answer: ExerciseAnswer) => request<ExerciseResult>(`/api/repositories/${repositoryId}/exercises/${encodeURIComponent(exerciseId)}/answer`, { method: "POST", body: JSON.stringify(answer) }),
  /** 代码题的按需讲评：判完之后点一次才发这一趟（默认不花钱，见 engine `exercises/explain`）。 */
  explainExercise: (repositoryId: string, exerciseId: string, answer: ExerciseAnswer) => request<{ explanation: string }>(`/api/repositories/${repositoryId}/exercises/${encodeURIComponent(exerciseId)}/explain`, { method: "POST", body: JSON.stringify(answer) }),
  getCost: (repositoryId: string, sessionId?: string) => request<CostSummary>(`/api/repositories/${repositoryId}/cost${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  setBudget: (repositoryId: string, monthlyBudgetUsd: number) => request<CostSummary>(`/api/repositories/${repositoryId}/settings`, { method: "PUT", body: JSON.stringify({ monthlyBudgetUsd }) }),
  createSession: (repositoryId: string, courseNodeId: string, settings?: TutorSettings) => request<{ session: TutorSession; recommendedSettings: LearnerProfile["recommended"]; faded: FadedState }>("/api/sessions", { method: "POST", body: JSON.stringify({ repositoryId, courseNodeId, ...(settings ? { settings } : {}) }) }),
  /** 按 id 取教学会话：内存未命中时引擎从 chat_session（含状态快照）+ chat_message 重建。 */
  getSession: (sessionId: string) => request<TutorSession>(`/api/sessions/${encodeURIComponent(sessionId)}`),
  /**
    会话线程（产品线真源在引擎的 chat_session / chat_message）：三作用域各一份独立列表。
    删除是软删——列表与正文从此看不见，行仍在库里；journal 另记一条 session_deleted。
    */
  listThreads: (repositoryId: string, scope: ChatScope) => request<{ threads: ChatThread[] }>(`/api/repositories/${repositoryId}/threads?scope=${scope}`),
  createThread: (repositoryId: string, payload: { scope: ChatScope; nodeId?: string; exerciseId?: string; title?: string }) => request<{ thread: ChatThread }>(`/api/repositories/${repositoryId}/threads`, { method: "POST", body: JSON.stringify(payload) }),
  getThreadMessages: (threadId: string) => request<{ thread: ChatThread; messages: ChatThreadMessage[] }>(`/api/threads/${encodeURIComponent(threadId)}/messages`),
  renameThread: (threadId: string, title: string) => request<{ thread: ChatThread }>(`/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteThread: (threadId: string) => request<{ deleted: boolean; threadId: string }>(`/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" }),
  /** 教学回合流式版：SSE 逐事件回调过程提示（progress）与正文增量（delta），resolve 于 done（session/message/cost/provider）。会话或节点失效仍是普通 JSON。 */
  sendMessageStream: (sessionId: string, content: string, settings: TutorSettings, onEvent: (event: TeachingStreamEvent) => void, turn: StreamTurn = {}) =>
    sseStream<{ session: TutorSession; message: { content: string }; cost: CostSummary; provider: string }>(
      `/api/sessions/${sessionId}/messages`,
      { content, settings, ...(turn.turnId ? { turnId: turn.turnId } : {}) },
      (event) => {
        if (event.type === "progress") onEvent({ type: "progress", payload: (event.payload ?? {}) as { stage?: string; round?: number; path?: string; query?: string } });
        else if (event.type === "delta") onEvent({ type: "delta", delta: String(event.delta ?? "") });
      },
      turn.signal
    ),
  /** map-chat 流式版：SSE 逐事件回调过程指示（thinking / reading / searching）与正文增量（delta），resolve 于 done 事件。threadId = 当前会话线程，引擎据此自取历史并落回合正文（GUI 不再回传窗口正文）；focus = 流程视图选中环节（课程树节点只到入口粒度，环节信息不上送模型就看不见）。 */
  mapChatStream: (repositoryId: string, payload: { content: string; nodeId?: string; scopePaths?: string[]; path?: string; focus?: FlowStage; threadId?: string; style: number }, onEvent: (event: ScopedChatEvent) => void, turn: StreamTurn = {}) =>
    sseStream<{ reply: string; provider: string }>(`/api/repositories/${repositoryId}/map-chat/stream`, { ...payload, ...(turn.turnId ? { turnId: turn.turnId } : {}) }, (event) => mapScopedEvent(event, onEvent), turn.signal),
  /** 练习追问：与 map-chat 同款 SSE（done/error/delta）；线程无效是 409、练习或仓库失效是 404，都走普通 JSON。 */
  practiceChat: (repositoryId: string, payload: { content: string; exerciseId: string; threadId?: string; style: number }, onEvent: (event: ScopedChatEvent) => void, turn: StreamTurn = {}) =>
    sseStream<{ reply: string; provider: string }>(`/api/repositories/${repositoryId}/practice-chat`, { ...payload, ...(turn.turnId ? { turnId: turn.turnId } : {}) }, (event) => mapScopedEvent(event, onEvent), turn.signal),
  /** 「停止生成」的带外通知：告诉引擎这一轮不要算了。404 = 那一轮已经结束，对界面来说同样是「停下来了」，所以调用方吞掉错误即可。 */
  stopTurn: (turnId: string) => request<{ stopped: boolean }>("/api/turns/stop", { method: "POST", body: JSON.stringify({ turnId }) })
};

/**
  全局事件流（`GET /api/events`，导入进度与仓库更新）。

  **为什么不用 `EventSource`**（2026-10-15 改了理由）：原先是为了能带认证请求头，那条需求随认证闸一起撤了
  （§64）。留下 fetch 读流是因为三条流共用同一套读流、退避与 abort 语义——
  重连自己管：指数退避 1s→2s→4s→8s→16s，20s 封顶，
  一旦成功建立连接就清零。`AbortSignal` 用来在依赖变化/卸载时彻底停下（含正在退避的那一次等待）。
  注释帧（`: open` / `: ping`）在这里被 `data: ` 那一条筛掉——引擎现在开局就发一帧把响应头推到网路上，
  所以 `fetch` 立刻 resolve，连接状态是实测的而不是等第一个事件才知道。

  **空闲看门狗**（10-12 实测补的）：引擎死了但中间的代理/反代还替它挂着这条连接时，
  `reader.read()` 既不 resolve 也不 reject，退避重连这条码路永远不会被触发——
  表现为「界面停在 40% 不动，而引擎其实早就没了」。`EventSource` 时代由浏览器管这件事，
  换成 fetch 之后必须自己管。阈值取 75s（引擎每 25s 一帧心跳，等于容忍连丢三帧），
  超时是**掐掉这一次尝试**再按退避重连，不是整条订阅作废。
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
                onEvent(JSON.parse(line.slice(6)) as ServerEvent);
              } catch {
                /* 畸形帧跳过：一条坏帧不该断掉整条流 */
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // 空闲超时走的就是这一支：掐掉这一次尝试，下面按同一份退避重连
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
