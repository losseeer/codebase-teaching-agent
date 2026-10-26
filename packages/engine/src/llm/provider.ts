import { maskSecrets } from "../security/secrets.js";
import { applyThinking } from "./thinking.js";

/**
  出网前的最后一道筛：三个真发请求的 provider 在 complete 第一行各调一次。
  防线长在出口而不指望每个装配点自觉；判据与 security/secrets.ts 同一份——掩码串不会被二次命中，
  已筛过的文本再过一次原样返回；没命中密钥时不重拼消息（缓存前缀逐字节不变）。
  */
export function screenOutbound(input: LlmCompletionInput): LlmCompletionInput {
  const system = maskSecrets(input.system);
  const user = typeof input.user === "string" ? maskSecrets(input.user) : { text: input.user, masked: 0 };
  let messageMasked = 0;
  const messages = input.messages?.map((message) => {
    const content = typeof message.content === "string" ? maskSecrets(message.content) : undefined;
    // 工具参数与 reasoning 也是出网正文：多轮循环里模型把学习者贴进来的 key 复述进这两处，不过筛就原样发走
    const reasoning = typeof message.reasoningContent === "string" ? maskSecrets(message.reasoningContent) : undefined;
    const toolCalls = message.toolCalls?.map((call) => maskSecrets(call.argumentsJson));
    const hits = (content?.masked ?? 0) + (reasoning?.masked ?? 0) + (toolCalls?.reduce((sum, call) => sum + call.masked, 0) ?? 0);
    if (!hits) return message;
    messageMasked += hits;
    return {
      ...message,
      ...(content ? { content: content.text } : {}),
      ...(reasoning ? { reasoningContent: reasoning.text } : {}),
      ...(toolCalls ? { toolCalls: toolCalls.map((call, index) => (call.masked ? { ...message.toolCalls![index], argumentsJson: call.text } : message.toolCalls![index])) } : {})
    };
  });
  const masked = system.masked + user.masked + messageMasked;
  if (!masked) return input;
  return {
    ...input,
    system: system.text,
    ...(user.text !== input.user ? { user: user.text } : {}),
    ...(messages ? { messages } : {})
  };
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** DeepSeek 系返回：命中自动上下文缓存的 prompt token 数（命中部分约 1/10 价）。undefined = 端点未上报。 */
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

/** 工具定义（OpenAI function 形状的引擎侧简化版）。 */
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/** 多轮工具循环中的消息。reasoningContent 仅在模型响应里出现时才需要原样回传（DeepSeek thinking + tools 的 API 要求）。 */
export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  reasoningContent?: string;
}

export interface LlmCompletionInput {
  system: string;
  /** 单轮调用的用户消息；提供 messages 时可省略。 */
  user?: string;
  /** 工具循环的既有对话（assistant 带 toolCalls / tool 为结果）。提供时忽略 user。 */
  messages?: LlmMessage[];
  tools?: LlmTool[];
  maxTokens?: number;
  temperature?: number;
  /** 思考模式控制（DeepSeek V4 官方参数，语义见 ThinkingEffort）。省略 = 不发任何思考字段（auto，模型默认行为）。 */
  thinking?: ThinkingEffort;
  /** 调用场景标签（如 "teaching.turn" / "practice.generate"），只用于 LLM 工作日志（llm/call-log.ts）。协议层不发送。 */
  scene?: string;
  /** 外部中止信号（只有用户点「停止生成」会置位；SSE 客户端断开不中止回合，照常算完落库）。触发后 fetch 立即断开并抛 LlmAbortedError。 */
  signal?: AbortSignal;
}

/**
  外部中止专用错误：必须与「超时」区分开。带 llmAborted 标记后，重试层与 harness 的降级 catch
  都会把中止原样上抛，不伪装成失败、也不重发已停止的那一轮。
  */
export class LlmAbortedError extends Error {
  readonly llmAborted = true;
  constructor() {
    super("LLM 调用已被中止（用户停止）");
    this.name = "LlmAbortedError";
  }
}

/** 是否属于「不该再试、也不该降级」的中止：本层抛的哨兵，或调用方信号已置位。 */
export function isLlmAborted(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof error === "object" && error !== null && (error as { llmAborted?: boolean }).llmAborted === true;
}

/** 超时与外部中止共用一个 fetch signal；dispose 必须调用，否则长生命周期 signal 上会堆积监听器。 */
interface LinkedFetchSignal {
  signal: AbortSignal;
  dispose(): void;
}

function linkFetchSignal(timeoutMs: number, external?: AbortSignal): LinkedFetchSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = (): void => controller.abort();
  if (external) {
    // 已置位的 signal 加监听器不会回调，必须直接 abort
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", relay, { once: true });
  }
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); external?.removeEventListener("abort", relay); } };
}

/** AbortError 归因：fetch 抛的 AbortError 对「超时」和「用户点停止」完全同形，
    外部信号已置位时换成哨兵，其余原样返回（各 provider 自己的超时文案保持不变）。 */
function attributeAbort(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof LlmAbortedError) return error;
  if (signal?.aborted && error instanceof Error && error.name === "AbortError") return new LlmAbortedError();
  return error;
}

/** 非 2xx 的统一出口：状态码挂在错误上供重试层判据，服务商回的原因带进文案（过密钥筛、截 300 字）。 */
async function httpFailure(response: Response, label: string): Promise<Error> {
  let reason = "";
  try {
    reason = maskSecrets(await response.text()).text.replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    // 原因读不出来就只报状态码
  }
  const error = new Error(`${label}（HTTP ${String(response.status)}）${reason ? `：${reason}` : ""}`);
  Object.defineProperty(error, "httpStatus", { value: response.status, configurable: true });
  return error;
}

/**
  思考模式档位（跨家族统一语义，各家族的真实参数格式与取值见 llm/thinking.ts 能力表）：
  - "off"：关闭思考（DeepSeek/Anthropic 发 thinking disabled；OpenAI 系发 reasoning_effort:none；
    无思考参数的模型 = 不发字段）
  - "low" / "high" / "max"：开启思考并指定强度（各家族映射到自家 API 取值，不支持即显式报错）
  - "auto"：不发字段，模型默认行为
  */
export type ThinkingEffort = "off" | "low" | "high" | "max";

export interface LlmCompletion {
  text: string;
  toolCalls?: LlmToolCall[];
  reasoningContent?: string;
  usage?: LlmUsage;
  finishReason?: string;
  /**
    第几次尝试拿到的这个结果（1 = 一次就成）。只有 RetryLlmProvider 会填——
    日志包在重试层外面，一次逻辑调用只落一行，不带出来就观测不到重试。
    */
  attempts?: number;
  /** 每次尝试各自的墙钟（ms），按发生顺序。`[60000, 15000]` 这种形状就是「被超时中止一次再发一遍并成了」。 */
  attemptMs?: number[];
  /** 这一发的 max_tokens 是加过一档推理余量之后才成的（上一发被思考量挤空）。 */
  headroomEscalated?: boolean;
}

/** 给用户看的截断尾注：正文被 max_tokens 中止时明示边界，别让半截句子伪装成完整结论。 */
export const TRUNCATION_TAIL = "\n\n（回复因达到输出长度上限被截断，说「继续」可以接着讲。）";

/** 可见回复被中止（token 达到预算上限，或被调用方的字符兜底切过）时加尾注；空文不加（由调用方走各自的兜底文案）。 */
export function flagTruncatedReply(text: string, truncated: boolean): string {
  return truncated && text && !text.endsWith(TRUNCATION_TAIL) ? `${text}${TRUNCATION_TAIL}` : text;
}

export interface LlmProvider {
  readonly name: string;
  readonly modelVersion: string;
  complete(input: LlmCompletionInput): Promise<LlmCompletion>;
}

export interface TeachingProviderStatus {
  provider: string;
  model: string;
  mode: "remote" | "local";
}

interface FetchProviderOptions {
  endpoint: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function tokenUsage(input: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number }): LlmUsage | undefined {
  const inputTokens = input.prompt_tokens ?? input.input_tokens;
  const outputTokens = input.completion_tokens ?? input.output_tokens;
  if (typeof inputTokens !== "number" && typeof outputTokens !== "number") return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    promptCacheHitTokens: typeof input.prompt_cache_hit_tokens === "number" ? input.prompt_cache_hit_tokens : undefined,
    promptCacheMissTokens: typeof input.prompt_cache_miss_tokens === "number" ? input.prompt_cache_miss_tokens : undefined
  };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : (item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : "")).join("").trim();
  return "";
}

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
  }
  const payload: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.toolCalls?.length) {
    payload.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.argumentsJson }
    }));
  }
  // DeepSeek thinking 模式 + tools 的官方要求：reasoning_content 必须逐轮原样回传，否则 400。
  // 该字段只在模型响应里出现时才被记录，因此真实 OpenAI 等不产生它的服务永远不会收到这个多余字段。
  if (message.reasoningContent) payload.reasoning_content = message.reasoningContent;
  return payload;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name = "OpenAI-compatible teaching model";
  readonly modelVersion: string;
  private readonly fetchImpl: typeof fetch;
  /**
    推理模型的 reasoning token 计入 max_tokens 上限，故在请求上限上直接加一档余量；
    非推理模型用完即停、不为多余上限多花 token，无条件加上是安全的。可用 TUTOR_LLM_REASONING_HEADROOM 调整（0 = 关闭）。
    */
  private readonly reasoningHeadroom: number;

  constructor(private readonly options: FetchProviderOptions) {
    this.modelVersion = `openai:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const raw = process.env.TUTOR_LLM_REASONING_HEADROOM?.trim();
    // 空串（`.env` 模板里 `KEY=` 就是这个形状）按默认 6000；显式填 0 才是关闭
    const headroom = raw ? Number(raw) : 6_000;
    this.reasoningHeadroom = Number.isFinite(headroom) && headroom > 0 ? Math.floor(headroom) : 0;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    input = screenOutbound(input);
    const base = input.maxTokens ?? 700;
    const first = await this.attemptOnce(input, base + this.reasoningHeadroom);
    if (!first.truncated) return first.completion;
    /**
      截断且正文为空时按加过两档余量的预算重发一次：多半是那一发的思考量瞬时超预算，不是请求本身坏。
      余量被关成 0 时不重发（同样预算再发一次没有意义），直接抛错说明原因。
    */
    if (!this.reasoningHeadroom) throw OpenAICompatibleProvider.truncatedError(base, 0, false);
    const second = await this.attemptOnce(input, base + this.reasoningHeadroom * 2);
    if (second.truncated) throw OpenAICompatibleProvider.truncatedError(base + this.reasoningHeadroom * 2, this.reasoningHeadroom, true);
    return { ...second.completion, headroomEscalated: true };
  }

  private static truncatedError(budget: number, headroom: number, escalated: boolean): Error {
    return new Error(`LLM 补全${escalated ? "两发都" : ""}被 max_tokens=${String(budget)} 截断且正文为空：推理模型的思考 token 计入这个上限。当前余量 TUTOR_LLM_REASONING_HEADROOM=${String(headroom)}——再调大它，或改用非推理模型。`);
  }

  /** 发一发并解析。返回 `truncated` 而不是抛，是为了让调用方能区分「换一档还有救」与「真的没内容」。 */
  private async attemptOnce(input: LlmCompletionInput, budget: number): Promise<{ truncated: true } | { truncated: false; completion: LlmCompletion }> {
    const messages: Record<string, unknown>[] = [{ role: "system", content: input.system }];
    if (input.messages?.length) {
      messages.push(...input.messages.map(toOpenAiMessage));
    } else {
      messages.push({ role: "user", content: input.user });
    }
    const payload: Record<string, unknown> = {
      model: this.options.model,
      temperature: input.temperature ?? 0.2,
      max_tokens: budget,
      messages
    };
    // 思考参数按模型能力声明组装（llm/thinking.ts 查表）；显式下发不支持的档位直接抛错，省略时不发任何思考字段。
    if (input.thinking) applyThinking(payload, this.options.model, input.thinking);
    if (input.tools?.length) {
      payload.tools = input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
      payload.tool_choice = "auto";
    }
    const body = await this.requestJson(`${this.options.endpoint.replace(/\/$/, "")}/chat/completions`, payload, input.signal) as {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number };
    };
    const choice = body.choices?.[0];
    const text = contentText(choice?.message?.content);
    const toolCalls: LlmToolCall[] = (choice?.message?.tool_calls ?? []).flatMap((call) => {
      const name = call.function?.name;
      if (!name) return [];
      return [{ id: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`, name, argumentsJson: call.function?.arguments ?? "{}" }];
    });
    if (!text && !toolCalls.length) {
      if (choice?.finish_reason === "length") return { truncated: true };
      throw new Error("模型没有返回内容");
    }
    const reasoningRaw = choice?.message?.reasoning_content;
    return {
      truncated: false,
      completion: {
        text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        reasoningContent: typeof reasoningRaw === "string" && reasoningRaw ? reasoningRaw : undefined,
        usage: body.usage ? tokenUsage(body.usage) : undefined,
        finishReason: choice?.finish_reason
      }
    };
  }

  /** 发一发并取回 JSON 正文。超时与外部中止必须覆盖到正文读完：`dispose()` 放在 `finally`，而 `json()` 在 `try` 内。 */
  private async requestJson(url: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeoutMs = this.options.timeoutMs ?? 12_000;
    const linked = linkFetchSignal(timeoutMs, signal);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify(payload),
        signal: linked.signal
      });
      if (!response.ok) throw await httpFailure(response, "模型服务出错");
      return await response.json();
    } catch (error) {
      const attributed = attributeAbort(error, signal);
      // 顺序是刻意的：先归因外部中止，再判超时——否则用户点停止会被写成「请求超时」并被重试层重发。
      if (attributed instanceof LlmAbortedError) throw attributed;
      if (attributed instanceof Error && attributed.name === "AbortError") {
        throw new Error(`模型请求超时。`);
      }
      throw attributed;
    } finally {
      linked.dispose();
    }
  }
}

/** Retries transient provider failures before the harness takes its local path. */
export class RetryLlmProvider implements LlmProvider {
  readonly name: string;
  readonly modelVersion: string;

  constructor(private readonly primary: LlmProvider, private readonly attempts = 2) {
    this.name = `${primary.name} with retry`;
    this.modelVersion = primary.modelVersion;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    let lastError: unknown;
    const attemptMs: number[] = [];
    for (let attempt = 0; attempt < Math.max(1, this.attempts); attempt += 1) {
      const started = Date.now();
      try {
        const completion = await this.primary.complete(input);
        attemptMs.push(Date.now() - started);
        return { ...completion, attempts: attempt + 1, attemptMs };
      } catch (error) {
        attemptMs.push(Date.now() - started);
        // 中止优先于「可重试」判定：用户已经停了，不再重发同一轮；
        // 判据带 signal 而不只看错误——response.json() 阶段的 AbortError 不带哨兵标记。
        if (isLlmAborted(error, input.signal)) throw markAttempts(error instanceof LlmAbortedError ? error : new LlmAbortedError(), attempt + 1, attemptMs);
        if (isNonRetryable(error)) throw markAttempts(error, attempt + 1, attemptMs);
        lastError = markAttempts(error, attempt + 1, attemptMs);
        if (attempt + 1 < this.attempts) await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : markAttempts(new Error("LLM request failed"), attemptMs.length, attemptMs);
  }
}

/**
  把「试了几次、每次多久」挂到错误对象上，供外层日志计入审计。
  用 `defineProperty` 而不是直接赋值：`Error` 上的 enumerable 属性会被 `JSON.stringify(err)` 之类带出去，
  而这里要的只是一条读数，不该改变错误对象的对外形状。
  */
function markAttempts(error: unknown, attempts: number, attemptMs: number[]): unknown {
  if (error instanceof Error) {
    Object.defineProperty(error, "attempts", { value: attempts, configurable: true });
    Object.defineProperty(error, "attemptMs", { value: attemptMs, configurable: true });
  }
  return error;
}

/** 确定性 4xx（除 408 / 429）不做重试：同样的请求原样重发只会原样再败。 */
function isNonRetryable(error: unknown): boolean {
  const code = httpStatusOf(error);
  return code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429;
}

/** 状态码优先取错误上挂的 `httpStatus`；扫文案只服务包装层与外部抛出的错误。 */
function httpStatusOf(error: unknown): number | undefined {
  const attached = (error as { httpStatus?: unknown } | null | undefined)?.httpStatus;
  if (typeof attached === "number") return attached;
  const matched = /(?:LLM returned|HTTP) (\d{3})/.exec(error instanceof Error ? error.message : String(error));
  const code = Number(matched?.[1] ?? matched?.[2]);
  return Number.isFinite(code) && matched ? code : undefined;
}

/** 思考模式注入包装：把运行时档位附加到包装内 provider 的每一次调用上（"auto" = 原样透传不注入）。
    档位是部署/会话级决定（GUI 设置），包在 provider 层，不侵入各调用点。 */
export class ThinkingOverrideLlmProvider implements LlmProvider {
  readonly name: string;
  readonly modelVersion: string;
  constructor(private readonly inner: LlmProvider, private readonly effort: "auto" | ThinkingEffort) {
    this.name = effort === "auto" ? inner.name : `${inner.name} (thinking:${effort})`;
    this.modelVersion = inner.modelVersion;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    return this.inner.complete(this.effort === "auto" || input.thinking ? input : { ...input, thinking: this.effort });
  }
}

function defaultModel(): string {
  return "gpt-4o-mini";
}

/** GUI 运行时可改的 LLM 配置覆盖（持久化与掩码见 llm/runtime.ts）：省略或空串 = 该字段回落 .env。 */
export interface LlmConfigOverrides {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

const trimmed = (value?: string): string => value?.trim() ?? "";

/**
  一份配置的三层回落：GUI 运行时覆盖 → .env（只有 TUTOR_LLM_* 一套）→ 该协议默认。
  provider 没配时返回 `provider: ""`，由 createLlmProvider 判成「未配置」。
  密钥只认通用名 OPENAI_API_KEY，不认引擎专属别名——别名会被读成另一份配置。
  */
export function resolveLlmConfig(overrides: LlmConfigOverrides = {}): ResolvedLlmConfig {
  const provider = (trimmed(overrides.provider) || process.env.TUTOR_LLM_PROVIDER || "").toLowerCase();
  const baseUrl = trimmed(overrides.baseUrl);
  const apiKey = trimmed(overrides.apiKey);
  const model = trimmed(overrides.model) || process.env.TUTOR_LLM_MODEL || defaultModel();
  // 留空与非法值都回落到默认：`Number("")` 是 0，而 0ms 定时器会把每一发真实请求当场判成超时（重试层再补一发，全部模型路径瘫痪）
  const timeoutMs = Math.max(1_000, Number(process.env.TUTOR_LLM_TIMEOUT_MS) || 12_000);
  return { provider, model, baseUrl: baseUrl || process.env.TUTOR_OPENAI_URL || "https://api.openai.com/v1", apiKey: apiKey || process.env.OPENAI_API_KEY, timeoutMs };
}

/**
  一份 LLM 配置的最终生效值：每个字段都是「GUI 运行时覆盖 → .env → 该协议默认」三层回落后的结果，
  所以这个结构本身不带来源信息——GUI 要知道哪些是回落值，由路由另外下发 .env 预设。
  */
export interface ResolvedLlmConfig {
  /** 空串 = 一个都没配（createLlmProvider 返回 undefined：L1 摘要与规则题走确定性档，三作用域对话与 LLM 出题在发请求前 422） */
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

function createProvider(config: ResolvedLlmConfig): LlmProvider | undefined {
  const { provider, model, baseUrl, apiKey, timeoutMs } = config;
  if (provider === "openai" || provider === "openai-compatible") {
    // 官方 openai 协议没有 key 必然 401，直接不建实例；兼容端点（Ollama/LM Studio 的 OpenAI 层）允许无 key 本地跑
    if (provider === "openai" && !apiKey) return undefined;
    return new RetryLlmProvider(new OpenAICompatibleProvider({ endpoint: baseUrl, apiKey, model, timeoutMs }));
  }
  return undefined;
}

/**
  唯一的 LLM 工厂：.env 只有一套 TUTOR_LLM_*。「轻任务 / 教学对话」是运行时角色
  （差别只在思考开关，见 llm/runtime.ts），不是两份配置；也不读引擎专属的密钥别名。
  */
export function createLlmProvider(overrides?: LlmConfigOverrides): LlmProvider | undefined {
  const config = resolveLlmConfig(overrides);
  return config.provider ? createProvider(config) : undefined;
}

export function teachingProviderStatus(provider?: LlmProvider): TeachingProviderStatus {
  return provider
    ? { provider: provider.name, model: provider.modelVersion, mode: "remote" }
    : { provider: "local deterministic fallback", model: "local-heuristic-v1", mode: "local" };
}
