import type { ChatScope, ChatThread, ChatThreadMessage, CostSummary, CourseNodeDetail, CourseNodePage, CourseTree, Exercise, ExerciseAnswer, ExerciseKind, ExerciseResult, FadedState, FlowStage, ImportEstimate, ImportJob, ImpactResult, LearnerProfile, PracticeSummary, RepositoryAnalysis, RepositoryFlowResult, RepositoryIndex, RepositoryOverview, SuggestedEntry, TutorSession, TutorSettings } from "@codebase-tutor/shared";

/**
 * 当前激活的工作区：被学习的仓库 ID 与路径。所有视图（宏观设计 / 代码教学 / 练习评估 / 成本监控）
 * 都以这个 workspace 为锚点。Agent 侧栏、伴侣面板、localStorage 也按 repositoryId 持久化。
 *
 * 对应 prototype `design-prototype.html` 中的 `binds[scope]` 概念。
 */
export interface Workspace {
  repositoryId: string;
  repositoryPath: string;
}

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

/** LLM 运行时设置（引擎内存态，PUT 后立即生效，重启回落 .env）。 */
export type ThinkingEffort = "auto" | "off" | "low" | "high" | "max";

/** 模型思考能力声明（引擎按模型 slug 查表解析，见 engine llm/thinking.ts）。efforts 为该模型支持的显式档位（auto 恒可用）。 */
export interface ThinkingCapabilityInfo {
  model: string;
  style: "deepseek" | "openai" | "anthropic" | "none" | "unknown";
  efforts: Exclude<ThinkingEffort, "auto">[];
}

export interface LlmSettings {
  /** 运行时模型覆盖（空串 = 用 .env 配置）；轻任务/教学对话共用这一套配置 */
  model: string;
  thinking: ThinkingEffort;
  presets: string[];
  thinkingCapability?: ThinkingCapabilityInfo;
  /** PUT 响应里带：当前实际生效的模型 slug */
  activeModel?: string;
}

/** 带状态码的 HTTP 失败：调用方要区分「404 = 东西真没有」和「连不上 / 5xx = 引擎暂时不在」，两者的用户处置完全不同。 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 只有带 body 的请求才声明 JSON Content-Type：Fastify 见到「application/json + 空 body」会 400 拒掉，无体的 DELETE 就是这么被打回的。
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? "请求失败");
  return body;
}

export const api = {
  health: () => request<{ status: string }>("/api/health"),
  getLlmSettings: () => request<LlmSettings>("/api/llm/settings"),
  updateLlmSettings: (partial: { model?: string; thinking?: ThinkingEffort }) => request<LlmSettings>("/api/llm/settings", { method: "PUT", body: JSON.stringify(partial) }),
  submitImport: (path: string, summaryHeaderComments?: boolean) => request<ImportJob>("/api/imports", { method: "POST", body: JSON.stringify({ path, ...(summaryHeaderComments === undefined ? {} : { summaryHeaderComments }) }) }),
  getImport: (jobId: string) => request<ImportJob>(`/api/imports/${jobId}`),
  getIndex: (repositoryId: string) => request<RepositoryIndex>(`/api/repositories/${repositoryId}/index`),
  getCourse: (repositoryId: string) => request<CourseTree>(`/api/repositories/${repositoryId}/course`),
  getOverview: (repositoryId: string) => request<RepositoryOverview>(`/api/repositories/${repositoryId}/overview`),
  getCourseNodes: (repositoryId: string, parentId: string, offset = 0, limit = 30) => request<CourseNodePage>(`/api/repositories/${repositoryId}/course/nodes?parentId=${encodeURIComponent(parentId)}&offset=${offset}&limit=${limit}`),
  getCourseNodeDetail: (repositoryId: string, nodeId: string) => request<CourseNodeDetail>(`/api/repositories/${repositoryId}/analysis/node?nodeId=${encodeURIComponent(nodeId)}`),
  getAnalysis: (repositoryId: string) => request<RepositoryAnalysis>(`/api/repositories/${repositoryId}/analysis`),
  getReport: (repositoryId: string) => request<{ index: RepositoryIndex; estimate: { cachedFiles: number; summarizedFiles: number; estimatedInputTokens: number; estimatedCostUsd: number; provider: string }; entrypoints: { title: string; anchors: { path: string; line: number }[] }[] }>(`/api/repositories/${repositoryId}/report`),
  getSource: (repositoryId: string, path: string, line: number) => request<{ path: string; line: number; content: string }>(`/api/repositories/${repositoryId}/source?path=${encodeURIComponent(path)}&line=${line}`),
  getImpact: (repositoryId: string, changedPaths: string[]) => request<ImpactResult>(`/api/repositories/${repositoryId}/impact`, { method: "POST", body: JSON.stringify({ changedPaths }) }),
  getModuleEntries: (repositoryId: string, moduleLabel: string, moduleHint?: string) => request<{ entries: SuggestedEntry[]; source: "llm" | "heuristic" }>(`/api/repositories/${repositoryId}/module-entries?module=${encodeURIComponent(moduleLabel)}&hint=${encodeURIComponent(moduleHint ?? "")}`),
  /** 流程视图：按入口取一条 LLM 生成的执行流程；source=static 表示降级为静态调用链（reason 说明原因）。 */
  getRepositoryFlow: (repositoryId: string, entryPath: string) => request<RepositoryFlowResult>(`/api/repositories/${repositoryId}/flow?entry=${encodeURIComponent(entryPath)}`),
  getPractice: (repositoryId: string) => request<PracticeSummary>(`/api/repositories/${repositoryId}/practice`),
  getLearner: (repositoryId: string) => request<LearnerProfile>(`/api/repositories/${repositoryId}/learner`),
  createExercise: (repositoryId: string, options: { kind?: ExerciseKind; targetUnitId?: string; moduleId?: string; moduleIds?: string[]; family?: "comprehension" | "llm"; tag?: string; tagId?: string; variantNonce?: number } = {}) => request<Exercise>(`/api/repositories/${repositoryId}/exercises`, { method: "POST", body: JSON.stringify(options) }),
  submitExercise: (repositoryId: string, exerciseId: string, answer: ExerciseAnswer) => request<ExerciseResult>(`/api/repositories/${repositoryId}/exercises/${encodeURIComponent(exerciseId)}/answer`, { method: "POST", body: JSON.stringify(answer) }),
  getCost: (repositoryId: string, sessionId?: string) => request<CostSummary>(`/api/repositories/${repositoryId}/cost${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  setBudget: (repositoryId: string, monthlyBudgetUsd: number) => request<CostSummary>(`/api/repositories/${repositoryId}/settings`, { method: "PUT", body: JSON.stringify({ monthlyBudgetUsd }) }),
  /** 每仓设置视图：预算 + 「摘要参考注释」开关（默认关，见 engine summarizer）。 */
  getRepositorySettings: (repositoryId: string) => request<{ monthlyBudgetUsd: number; summaryHeaderComments: boolean }>(`/api/repositories/${repositoryId}/settings`),
  setSummaryHeaderComments: (repositoryId: string, enabled: boolean) => request<CostSummary & { settings: { monthlyBudgetUsd: number; summaryHeaderComments: boolean } }>(`/api/repositories/${repositoryId}/settings`, { method: "PUT", body: JSON.stringify({ summaryHeaderComments: enabled }) }),
  /** 按当前开关状态重烧 L1 摘要（切开关后必须调用才生效；409=确定性档，会拒绝覆盖）。 */
  rebuildSummaries: (repositoryId: string) => request<ImportEstimate>(`/api/repositories/${repositoryId}/summaries/rebuild`, { method: "POST", body: "{}" }),
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
    sseStream<{ reply: string; provider: string }>(`/api/repositories/${repositoryId}/map-chat/stream`, { ...payload, ...(turn.turnId ? { turnId: turn.turnId } : {}) }, (event) => {
      if (event.type === "thinking") onEvent({ type: "thinking", round: Number(event.round ?? 1) });
      else if (event.type === "reading") onEvent({ type: "reading", path: String(event.path ?? "") });
      else if (event.type === "searching") onEvent({ type: "searching", query: String(event.query ?? "") });
      else if (event.type === "delta") onEvent({ type: "delta", delta: String(event.delta ?? "") });
    }, turn.signal),
  /** 练习追问：与 map-chat 同款 SSE（done/error/delta）；线程无效是 409、练习或仓库失效是 404，都走普通 JSON。 */
  practiceChat: (repositoryId: string, payload: { content: string; exerciseId: string; threadId?: string; style: number }, onEvent: (event: ScopedChatEvent) => void, turn: StreamTurn = {}) =>
    sseStream<{ reply: string; provider: string }>(`/api/repositories/${repositoryId}/practice-chat`, { ...payload, ...(turn.turnId ? { turnId: turn.turnId } : {}) }, (event) => {
      if (event.type === "thinking") onEvent({ type: "thinking", round: Number(event.round ?? 1) });
      else if (event.type === "reading") onEvent({ type: "reading", path: String(event.path ?? "") });
      else if (event.type === "delta") onEvent({ type: "delta", delta: String(event.delta ?? "") });
    }, turn.signal),
  /** 「停止生成」的带外通知：告诉引擎这一轮不要算了。404 = 那一轮已经结束，对界面来说同样是「停下来了」，所以调用方吞掉错误即可。 */
  stopTurn: (turnId: string) => request<{ stopped: boolean }>("/api/turns/stop", { method: "POST", body: JSON.stringify({ turnId }) })
};
