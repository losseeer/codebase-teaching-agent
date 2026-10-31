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
  type ExerciseBankEntry,
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

/** 当前激活的工作区：被学习仓库的 ID 与路径。 */
export interface Workspace {
  repositoryId: string;
  repositoryPath: string;
}

/** 一帧原始 JSON → 过程帧：先过契约，再按字段窄化。 */
export function parseScopedStreamFrame(raw: unknown): ScopedStreamProgress {
  return toScopedEvent(checkContract(scopedStreamProgressSchema, raw, "stream.progress"));
}

/** 契约通过后的窄化：缺字段取默认值；shared 新增类型未接时 never 断言编译不过。 */
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

/** 宏观设计回合 done 帧的两种形状：正常成品（reply）或被中断（interrupted，无成品）。 */
export type MapDoneFrame =
  | { reply: string; provider: string; diagram?: { id: string; name: string }; asked?: { toolCallId: string; facet: string; question: string; options: string[] }; interrupted?: undefined }
  | { reply?: undefined; provider: string; diagram?: { id: string; name: string }; asked?: undefined; interrupted: { reason: string; detail: string } };

/** 一次流式回合的客户端句柄：turnId 中止引擎侧回合，signal 中止本连接。 */
export interface StreamTurn {
  turnId?: string;
  signal?: AbortSignal;
}

/** 通用 SSE 读取：POST → 逐过程帧回调 → done 固化为返回值；error 抛 Error。 */
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
    // 中止帧由调用方本地收尾，这里跳过
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

/** LLM 运行时设置：GUI 可改，引擎落盘，留空项回落 .env。 */
export type ThinkingEffort = "auto" | "off" | "low" | "high" | "max";

/** 服务商协议，与引擎 llm/runtime.ts 的 LLM_PROVIDERS 一致；空串 = 用 .env。 */
export type LlmProviderKind = "openai-compatible" | "openai";

/** 模型思考能力声明；efforts 为该模型支持的显式档位（auto 恒可用）。 */
export interface ThinkingCapabilityInfo {
  model: string;
  style: "deepseek" | "openai" | "anthropic" | "none" | "unknown";
  efforts: Exclude<ThinkingEffort, "auto">[];
}

/** .env 侧回落值，引擎解析一次下发。 */
export interface LlmEnvFallback {
  provider: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  /** 留空时实际生效的超时（毫秒）。 */
  timeoutMs?: number;
}

/** 单价某一档的来源：runtime=LLM 配置框，env=.env，unset=两层都没配。 */
export type PricingSource = "runtime" | "env" | "unset";

export interface LlmSettings {
  /** 运行时服务商覆盖；空串 = 用 .env。 */
  provider: string;
  /** 运行时模型覆盖；空串 = 用 .env。 */
  model: string;
  baseUrl: string;
  thinking: ThinkingEffort;
  /** 只回掩码，引擎从不回显明文。 */
  apiKeyMasked: string;
  hasApiKey: boolean;
  envFallback: LlmEnvFallback;
  thinkingCapability?: ThinkingCapabilityInfo;
  /**
    单价三档填写值（空串 = 该档交给 .env），单位人民币 / 百万 token。
    字段名里的 USD 实指人民币。
    */
  inputUsdPerMillion?: string;
  outputUsdPerMillion?: string;
  cacheHitUsdPerMillion?: string;
  /** 单次请求超时（毫秒），空串 = 用 .env。 */
  timeoutMs?: string;
  activeTimeoutMs?: number;
  timeoutRange?: { minMs: number; maxMs: number };
  /** 当前生效的三档单价（人民币 / 百万 token）。 */
  pricing?: { inputPerMillionUsd: number; cacheHitPerMillionUsd?: number; outputPerMillionUsd: number };
  pricingSources?: { input: PricingSource; output: PricingSource; cacheHit: PricingSource };
  /** 当前生效的 provider/模型/模式；local = 配置不齐或密钥缺失。 */
  activeModel?: string;
  activeProvider?: string;
  activeMode?: "remote" | "local";
}

/** PUT 的部分更新：省略 = 保持不变，空串 = 清除该项并回落 .env（apiKey 空串即删除已存密钥）。 */
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

/** 带状态码的 HTTP 失败；仓库类 404 带 reason（不在地址簿 / 目录没了 / 产物不全）。 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly reason?: RepositoryMountReason) {
    super(message);
    this.name = "ApiError";
  }
}

export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

async function requestRaw(path: string, init?: RequestInit): Promise<unknown> {
  // 仅带 body 时声明 JSON Content-Type：Fastify 会以 400 拒「json 头 + 空 body」的无体请求
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const body = await response.json() as { error?: string; reason?: RepositoryMountReason };
  if (!response.ok) throw new ApiError(response.status, body.error ?? "请求失败", body.reason);
  return body;
}

/** 未套契约的端点：编译期声明 + 一次 as。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestRaw(path, init)) as T;
}

/** 边界校验：不符契约抛 ContractViolation（带格名）。 */
async function checked<T>(name: string, schema: ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  return checkContract(schema, await requestRaw(path, init), name);
}

/**
  画图工作区线上形状：位置更新只带坐标；
  warning 标记 ref 已不在当前索引的节点，界面画成失效。
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

/** 画布保存状态；failed 必须显形，不替失败的写入说「已保存」。 */
export type SaveState = "synced" | "queued" | "saving" | "saved" | "failed";

export const api = {
  getLlmSettings: () => request<LlmSettings>("/api/llm/settings"),
  updateLlmSettings: (partial: LlmSettingsPatch) => request<LlmSettings>("/api/llm/settings", { method: "PUT", body: JSON.stringify(partial) }),
  submitImport: (path: string, summaryHeaderComments?: boolean) => request<ImportJob>("/api/imports", { method: "POST", body: JSON.stringify({ path, ...(summaryHeaderComments === undefined ? {} : { summaryHeaderComments }) }) }),
  getImport: (jobId: string) => checked<ImportJob>("import", importJobSchema, `/api/imports/${jobId}`),
  /** 地址簿：只列不读产物。 */
  listRepositories: () => checked("repositories", z.object({ repositories: z.array(repositoryCatalogEntrySchema) }), "/api/repositories"),
  /** 挂载仓库并拿新鲜度判定；失败按 reason 抛错。 */
  mountRepository: (repositoryId: string) => request<{ repositoryId: string; repositoryPath: string; freshness: RepositoryFreshness }>(`/api/repositories/${repositoryId}/mount`, { method: "POST" }),
  /** 移出地址簿；只动引擎登记，不碰仓库里的 .tutor/。 */
  forgetRepository: (repositoryId: string, artifacts = false) => request<{ repositories: RepositoryCatalogEntry[]; artifacts?: "removed" | "absent" | "refused" }>(`/api/repositories/${repositoryId}${artifacts ? "?artifacts=1" : ""}`, { method: "DELETE" }),
  getIndex: (repositoryId: string) => request<RepositoryIndex>(`/api/repositories/${repositoryId}/index`),
  /** 导入报告：索引概况 + 本次 token/金额估算。 */
  getReport: (repositoryId: string) => request<{ index: RepositoryIndex; estimate: { cachedFiles: number; summarizedFiles: number; estimatedInputTokens: number; estimatedCostUsd: number; provider: string } }>(`/api/repositories/${repositoryId}/report`),
  /** 按文件路径取实时源码。 */
  getSource: (repositoryId: string, path: string, line: number) => request<{ path: string; line: number; content: string }>(`/api/repositories/${repositoryId}/source?path=${encodeURIComponent(path)}&line=${line}`),
  /* ---- 画图工作区：七条路由只读写库里的图元，不碰模型。
     结构改动只经 agent 的 set_diagram；界面只提供拖动与改名。 ---- */
  /** 图库列表：只有摘要，不含整张结构。 */
  listDiagrams: (repositoryId: string) => request<{ diagrams: DiagramSummary[] }>(`/api/repositories/${repositoryId}/diagrams`),
  /** 新建空白图；名字省略则引擎起「未命名图」并去重。 */
  createDiagram: (repositoryId: string, name?: string) => request<{ diagram: Diagram }>(`/api/repositories/${repositoryId}/diagrams`, { method: "POST", body: JSON.stringify(name ? { name } : {}) }),
  /** 打开一张图；warnings 为 ref 已失效的节点。 */
  getDiagram: (repositoryId: string, diagramId: string) => request<{ diagram: Diagram; warnings: DiagramWarning[]; filesByNode: Record<string, { path: string; line: number }[]> }>(`/api/repositories/${repositoryId}/diagrams/${encodeURIComponent(diagramId)}`),
  renameDiagram: (repositoryId: string, diagramId: string, name: string) => request<{ diagram: Diagram }>(`/api/repositories/${repositoryId}/diagrams/${encodeURIComponent(diagramId)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteDiagram: (repositoryId: string, diagramId: string) => request<{ deleted: boolean; diagramId: string }>(`/api/repositories/${repositoryId}/diagrams/${encodeURIComponent(diagramId)}`, { method: "DELETE" }),
  /** 几何落盘：只送变化过的位置；不产生版本（版本只由 agent 结构改动产生）。 */
  saveDiagramGeometry: (repositoryId: string, diagramId: string, positions: DiagramPosition[]) => request<{ diagram: Diagram }>(`/api/repositories/${repositoryId}/diagrams/${encodeURIComponent(diagramId)}/geometry`, { method: "PUT", body: JSON.stringify({ positions }) }),
  /** 回到某一版快照（index 按 versions 下标，旧→新）；引擎会再存一版，历史不截断。 */
  restoreDiagram: (repositoryId: string, diagramId: string, index: number) => request<{ diagram: Diagram }>(`/api/repositories/${repositoryId}/diagrams/${encodeURIComponent(diagramId)}/restore`, { method: "POST", body: JSON.stringify({ index }) }),
  getPractice: (repositoryId: string) => request<PracticeSummary>(`/api/repositories/${repositoryId}/practice`),
  getLearner: (repositoryId: string) => request<LearnerProfile>(`/api/repositories/${repositoryId}/learner`),
  /** 题库：这个仓存着的题与复习排期，纯读。 */
  listExercises: (repositoryId: string) => request<{ exercises: ExerciseBankEntry[] }>(`/api/repositories/${repositoryId}/exercises`),
  deleteExercise: (repositoryId: string, exerciseId: string) => request<{ deleted: number }>(`/api/repositories/${repositoryId}/exercises/${encodeURIComponent(exerciseId)}`, { method: "DELETE" }),
  createExercise: (repositoryId: string, options: { kind?: ExerciseKind; targetUnitId?: string; tag?: string; tagId?: string; variantNonce?: number } = {}) => request<Exercise>(`/api/repositories/${repositoryId}/exercises`, { method: "POST", body: JSON.stringify(options) }),
  submitExercise: (repositoryId: string, exerciseId: string, answer: ExerciseAnswer) => request<ExerciseResult>(`/api/repositories/${repositoryId}/exercises/${encodeURIComponent(exerciseId)}/answer`, { method: "POST", body: JSON.stringify(answer) }),
  /** 代码题按需讲评：判分后点一次才发这一趟 LLM 调用。 */
  explainExercise: (repositoryId: string, exerciseId: string, answer: ExerciseAnswer) => request<{ explanation: string }>(`/api/repositories/${repositoryId}/exercises/${encodeURIComponent(exerciseId)}/explain`, { method: "POST", body: JSON.stringify(answer) }),
  getCost: (repositoryId: string, sessionId?: string) => checked<CostSummary>("cost", costSummarySchema, `/api/repositories/${repositoryId}/cost${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  setBudget: (repositoryId: string, monthlyBudgetUsd: number) => checked<CostSummary>("budget", costSummarySchema, `/api/repositories/${repositoryId}/settings`, { method: "PUT", body: JSON.stringify({ monthlyBudgetUsd }) }),
  createSession: (repositoryId: string, scopeRef: string, settings?: TutorSettings) => request<{ session: TutorSession; recommendedSettings: LearnerProfile["recommended"]; faded: FadedState }>("/api/sessions", { method: "POST", body: JSON.stringify({ repositoryId, scopeRef, ...(settings ? { settings } : {}) }) }),
  /** 按 id 取教学会话；未命中时引擎从 chat_session + chat_message 重建。 */
  getSession: (sessionId: string) => request<TutorSession>(`/api/sessions/${encodeURIComponent(sessionId)}`),
  // 会话线程真源在引擎的 chat_session / chat_message；删除是软删：行仍在库，列表与正文不可见。
  /** 会话清单：threads 只含已发言的会话；current 回认界面正打开的那条（未发言也认）。 */
  listThreads: (repositoryId: string, scope: ChatScope, current?: string) => checked("threads", z.object({ threads: z.array(chatThreadSchema), current: chatThreadSchema.nullable() }), `/api/repositories/${repositoryId}/threads?scope=${scope}${current ? `&current=${encodeURIComponent(current)}` : ""}`),
  createThread: (repositoryId: string, payload: { scope: ChatScope; scopeRef?: string; exerciseId?: string; title?: string }) => checked("thread", z.object({ thread: chatThreadSchema }), `/api/repositories/${repositoryId}/threads`, { method: "POST", body: JSON.stringify(payload) }),
  getThreadMessages: (threadId: string) => checked("threadMessages", z.object({ thread: chatThreadSchema, messages: z.array(chatThreadMessageSchema) }), `/api/threads/${encodeURIComponent(threadId)}/messages`),
  renameThread: (threadId: string, title: string) => checked("thread", z.object({ thread: chatThreadSchema }), `/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteThread: (threadId: string) => checked("threadDelete", z.object({ deleted: z.boolean(), threadId: z.string() }), `/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" }),
  /** 教学回合 SSE：逐事件回调 progress 与 delta，done 固化为返回值（session/message/cost/provider）。 */
  sendMessageStream: (sessionId: string, content: string, settings: TutorSettings, onEvent: (event: ScopedStreamProgress) => void, turn: StreamTurn = {}) =>
    sseStream<{ session: TutorSession; message: { content: string }; cost: CostSummary; provider: string }>(
      `/api/sessions/${sessionId}/messages`,
      { content, settings, ...(turn.turnId ? { turnId: turn.turnId } : {}) },
      onEvent,
      turn.signal
    ),
  /** map-chat SSE：done 两种形状（reply 或 interrupted）。diagramId = 画布当前打开的图。 */
  mapChatStream: (repositoryId: string, payload: { content: string; scopePaths?: string[]; path?: string; threadId?: string; diagramId?: string; style: number; resumeAsk?: string }, onEvent: (event: ScopedStreamProgress) => void, turn: StreamTurn = {}) =>
    sseStream<MapDoneFrame>(`/api/repositories/${repositoryId}/map-chat/stream`, { ...payload, ...(turn.turnId ? { turnId: turn.turnId } : {}) }, onEvent, turn.signal),
  /** 练习追问 SSE：与 map-chat 同款；diagram/asked/interrupted 恒不出现，done 形状与两条流对齐。 */
  practiceChat: (repositoryId: string, payload: { content: string; exerciseId: string; threadId?: string; style: number }, onEvent: (event: ScopedStreamProgress) => void, turn: StreamTurn = {}) =>
    sseStream<{ reply: string; provider: string; diagram?: undefined; asked?: undefined; interrupted?: undefined }>(`/api/repositories/${repositoryId}/practice-chat`, { ...payload, ...(turn.turnId ? { turnId: turn.turnId } : {}) }, onEvent, turn.signal),
  /** 停止生成的带外通知；404 = 该轮已结束，调用方丢弃错误即可。 */
  stopTurn: (turnId: string) => request<{ stopped: boolean }>("/api/turns/stop", { method: "POST", body: JSON.stringify({ turnId }) })
};

// 空闲看门狗阈值：引擎每 25s 发一帧心跳，75s = 容忍连丢三帧。
const STREAM_IDLE_MS = 75_000;

/** 全局事件流订阅（导入进度与仓库更新）：断线按指数退避重连，20s 封顶。 */
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
      // 每次尝试独立 controller：空闲超时只掐这一条连接
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
                // 坏帧只跳过，不断流
                onEvent(checkContract(serverEventSchema, JSON.parse(line.slice(6)), "events"));
              } catch (error) {
                console.error("[gui] 事件流有一帧不符契约，已跳过：", error instanceof Error ? error.message : error);
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // 空闲超时走这一支，随后按退避重连
        attempt.abort();
        if (stopped || controller.signal.aborted) break;
      } finally {
        controller.signal.removeEventListener("abort", relayAbort);
      }
      if (stopped || controller.signal.aborted) break;
      // 服务端正常收尾也到这里：按退避重连
      await delay(Math.min(1_000 * 2 ** failures++, 20_000));
    }
  })();

  return abortBoth;
}
