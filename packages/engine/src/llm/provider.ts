import { maskSecrets } from "../security/secrets.js";
import { applyThinking } from "./thinking.js";

/**
  出网前的**最后一道筛**（企业化第 2 条的总闸口）：三个真发请求的 provider 在 `complete` 第一行各调一次。

  为什么贴在发送边而不是只靠装配点：10-12 的审计查出四条漏网——出题的源码摘录、符号形参原文、
  L2 聚合上下文、向量批量——它们全是**后来新增的装配路径**，不是谁把旧代码改坏了。
  「每个新调用点都记得过筛」是指望不住的纪律，防线得长在出口上。

  判据与那几处装配点完全同一份（`security/secrets.ts`），掩码串不会被二次命中，
  所以已经筛过的文本再过一次是原样返回；没人命中密钥时也**不会重拼消息**（缓存前缀逐字节不变）。
  */
export function screenOutbound(input: LlmCompletionInput): LlmCompletionInput {
  const system = maskSecrets(input.system);
  const user = typeof input.user === "string" ? maskSecrets(input.user) : { text: input.user, masked: 0 };
  const messages = input.messages?.map((message) => {
    const screened = typeof message.content === "string" ? maskSecrets(message.content) : undefined;
    return screened && screened.masked ? { ...message, content: screened.text } : message;
  });
  const masked = system.masked + user.masked + (messages?.filter((message, index) => message !== input.messages?.[index]).length ?? 0);
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

/** 模型发起的一次工具调用。 */
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
  /** 外部中止信号（用户点「停止生成」或 SSE 客户端断开）。触发后 fetch 立即断开并抛 LlmAbortedError。 */
  signal?: AbortSignal;
}

/**
  外部中止专用错误：必须与「超时」区分开。两件事原来会撞在一起——
  OpenAI 兼容层把任何 AbortError 都改写成「LLM 请求超时」文案，
  而 RetryLlmProvider 只按 `returned 4xx` 判可重试，于是**用户刚点停止，引擎又把同一轮重发一遍**。
  带 llmAborted 标记后重试层与 harness 的降级 catch 都能把中止原样上抛，不伪装成失败或降级结论。
  */
export class LlmAbortedError extends Error {
  readonly llmAborted = true;
  constructor() {
    super("LLM 调用已被中止（用户停止或客户端断开）");
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
    第几次尝试拿到的这个结果（1 = 一次就成）。只有 `RetryLlmProvider` 会填——
    日志包在重试层**外面**，一次逻辑调用只落一行，「试了几次」不带出来就永远测不到（第三阶段点名的指标）。
    */
  attempts?: number;
  /** 每次尝试各自的墙钟（ms），按发生顺序。`[60000, 15000]` 这种形状就是「被超时中止一次再发一遍并成了」。 */
  attemptMs?: number[];
  /**
    这一发的 `max_tokens` 是**加过一档推理余量**之后才成的：说明上一发是被思考量挤空的。
    没有这个字段，日志里只看得见「一次成功、耗时略长」，看不出预算其实动过。
    */
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
    推理余量：推理模型（如 DeepSeek 系列）会把 reasoning token 计入 max_tokens 上限，
    调用点按非推理模型设的小上限（12~1600）会被思考烧光导致 content 为空。
    余量直接加在请求的 max_tokens 上——非推理模型不会为多余上限多花 token（用完即停），所以无条件加上是安全的。
    可用 TUTOR_LLM_REASONING_HEADROOM 调整（0 表示关闭）。
    默认 6000（2026-09-18 实测校准）：map.flow 全流程生成在 thinking=auto 下的自然思考量 **2.4k~4.2k+ tok**（探针直测 reasoning 4,203 + 正文 1,849 = 6,445 outputTokens）；
    旧默认 3000 + map.flow maxTokens 2400 = 5400，被 5 连败截断/空正文——思考余量必须按「最坏思考 + 满额正文」留。
    */
  private readonly reasoningHeadroom: number;

  constructor(private readonly options: FetchProviderOptions) {
    this.modelVersion = `openai:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const headroom = Number(process.env.TUTOR_LLM_REASONING_HEADROOM ?? 6_000);
    this.reasoningHeadroom = Number.isFinite(headroom) && headroom > 0 ? Math.floor(headroom) : 0;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    input = screenOutbound(input);
    const base = input.maxTokens ?? 700;
    const first = await this.attemptOnce(input, base + this.reasoningHeadroom);
    if (!first.truncated) return first.completion;
    /**
      只有一种败法值得**当场换一档预算重发**：被 `max_tokens` 截断且正文为空。实测（§62）这一族的同载荷
      重发后来 12/12 都成功了，说明多半是那一发的思考量瞬时超预算，不是请求本身坏。
      这与「原样重发同一份载荷」是两件事——那样赌的是运气，这次带的是信息。
      余量被关成 0 时不重发（再发一次同样的预算没有意义），直接把话说清让用户调。
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
    // 思考参数按模型能力声明组装（llm/thinking.ts 查表）：DeepSeek 走 thinking+reasoning_effort，
    // OpenAI 系走顶层 reasoning_effort，其余样式/未知模型不发字段；显式下发不支持的档位直接抛错。
    // 注意省略字段时不发任何思考字段，保持行为完全不变。
    if (input.thinking) applyThinking(payload, this.options.model, input.thinking);
    if (input.tools?.length) {
      payload.tools = input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
      payload.tool_choice = "auto";
    }
    const response = await this.request(`${this.options.endpoint.replace(/\/$/, "")}/chat/completions`, payload, input.signal);
    const body = await response.json() as {
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
      throw new Error("LLM returned an empty completion");
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

  private async request(url: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
    const timeoutMs = this.options.timeoutMs ?? 12_000;
    const linked = linkFetchSignal(timeoutMs, signal);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify(payload),
        signal: linked.signal
      });
      if (!response.ok) throw new Error(`LLM returned ${response.status}`);
      return response;
    } catch (error) {
      const attributed = attributeAbort(error, signal);
      // 顺序是刻意的：先归因外部中止，再判超时——否则用户点停止会被写成「请求超时」并被重试层重发。
      if (attributed instanceof LlmAbortedError) throw attributed;
      if (attributed instanceof Error && attributed.name === "AbortError") {
        throw new Error(`LLM 请求超时（${timeoutMs}ms）：推理模型生成较慢时可调大 TUTOR_LLM_TIMEOUT_MS。`);
      }
      throw attributed;
    } finally {
      linked.dispose();
    }
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "Anthropic teaching model";
  readonly modelVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FetchProviderOptions) {
    this.modelVersion = `anthropic:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    // 原生 Anthropic Messages API 的思考用 budget_tokens（预算制），与 effort 档位语义不同——未实现映射，
    // 显式档位直接报错而不是静默忽略（不许把失败伪装成结果）。off/auto = 不发思考字段。
    if (input.thinking && input.thinking !== "off") {
      throw new Error(`Anthropic 原生协议暂不支持思考档位 "${input.thinking}"（思考为 budget_tokens 预算制）。请用 auto/off，或改走 OpenAI 兼容端点。`);
    }
    input = screenOutbound(input);
    const endpoint = this.options.endpoint.replace(/\/$/, "");
    const response = await this.request(`${endpoint}/v1/messages`, {
      model: this.options.model,
      max_tokens: input.maxTokens ?? 700,
      temperature: input.temperature ?? 0.2,
      system: input.system,
      messages: [{ role: "user", content: input.user }]
    }, input.signal);
    const body = await response.json() as { content?: unknown; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = contentText(body.content);
    if (!text) throw new Error("LLM returned an empty completion");
    return { text, usage: body.usage ? tokenUsage(body.usage) : undefined, finishReason: body.stop_reason };
  }

  private async request(url: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
    const linked = linkFetchSignal(this.options.timeoutMs ?? 12_000, signal);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.options.apiKey ?? "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify(payload),
        signal: linked.signal
      });
      if (!response.ok) throw new Error(`Anthropic returned ${response.status}`);
      return response;
    } catch (error) {
      // 外部中止归因成哨兵后原样上抛；其余错误也一律原样（Anthropic 无超时改写）
      throw attributeAbort(error, signal);
    } finally {
      linked.dispose();
    }
  }
}

export class OllamaTeachingProvider implements LlmProvider {
  readonly name = "Ollama teaching model";
  readonly modelVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FetchProviderOptions) {
    this.modelVersion = `ollama:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    // 各 Ollama 模型的思考控制不统一（qwen3 等走 options.think / 模板变量），未做映射——
    // 显式档位直接报错而不是静默忽略。off/auto = 不发思考相关字段。
    if (input.thinking && input.thinking !== "off") {
      throw new Error(`Ollama provider 暂不支持思考档位 "${input.thinking}"。请用 auto/off。`);
    }
    input = screenOutbound(input);
    const linked = linkFetchSignal(this.options.timeoutMs ?? 12_000, input.signal);
    try {
      const response = await this.fetchImpl(`${this.options.endpoint.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: linked.signal,
        body: JSON.stringify({ model: this.options.model, stream: false, options: { temperature: input.temperature ?? 0.2, num_predict: input.maxTokens ?? 700 }, messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }] })
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const body = await response.json() as { message?: { content?: unknown }; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
      const text = contentText(body.message?.content);
      if (!text) throw new Error("LLM returned an empty completion");
      return { text, usage: tokenUsage({ input_tokens: body.prompt_eval_count, output_tokens: body.eval_count }), finishReason: body.done_reason };
    } catch (error) {
      // 同 Anthropic：只归因外部中止，其余原样上抛
      throw attributeAbort(error, input.signal);
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
        // 「第几次成的」必须带出去：外层日志一次逻辑调用只落一行，不带上就读不出重试发生过
        return { ...completion, attempts: attempt + 1, attemptMs };
      } catch (error) {
        attemptMs.push(Date.now() - started);
        // 中止优先于「可重试」判定：用户已经停了，重发同一轮只会再烧一遍 token；
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

/** 确定性 4xx（除 408 请求超时 / 429 限速）不做重试：同样的请求原样重发只会原样再败，
    白烧两次失败调用（借鉴 Claude Code s08 reactive_compact 的「先分类再决定升级路径」）。 */
function isNonRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = /(?:LLM|Anthropic|Ollama) returned (\d{3})/.exec(message)?.[1];
  if (!status) return false;
  const code = Number(status);
  return code >= 400 && code < 500 && code !== 408 && code !== 429;
}

/** 思考模式注入包装：把运行时档位附加到包装内 provider 的每一次调用上（"auto" = 原样透传不注入）。
    档位是「部署/会话级」决定（GUI 设置），不该侵入各调用点——所以包在 provider 层而不是改每个 complete 调用。 */
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

function defaultModel(provider: string): string {
  if (provider === "anthropic") return "claude-3-5-sonnet-20241022";
  if (provider === "ollama") return "llama3.2";
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
  一份配置的三层回落：GUI 运行时覆盖 → `.env`（只有 `TUTOR_LLM_*` 一套）→ 该协议默认。
  provider 没配时返回 `provider: ""`，由 createLlmProvider 判成「未配置」。
  密钥只认业界通用名 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`——一个值两把钥匙迟早读成两份配置。
  */
export function resolveLlmConfig(overrides: LlmConfigOverrides = {}): ResolvedLlmConfig {
  const provider = (trimmed(overrides.provider) || process.env.TUTOR_LLM_PROVIDER || "").toLowerCase();
  const baseUrl = trimmed(overrides.baseUrl);
  const apiKey = trimmed(overrides.apiKey);
  const model = trimmed(overrides.model) || process.env.TUTOR_LLM_MODEL || defaultModel(provider);
  const timeoutMs = Number(process.env.TUTOR_LLM_TIMEOUT_MS ?? 12_000);
  if (provider === "anthropic") return { provider, model, baseUrl: baseUrl || "https://api.anthropic.com", apiKey: apiKey || process.env.ANTHROPIC_API_KEY, timeoutMs };
  if (provider === "ollama") return { provider, model, baseUrl: baseUrl || process.env.TUTOR_OLLAMA_URL || "http://127.0.0.1:11434", timeoutMs };
  return { provider, model, baseUrl: baseUrl || process.env.TUTOR_OPENAI_URL || "https://api.openai.com/v1", apiKey: apiKey || process.env.OPENAI_API_KEY, timeoutMs };
}

/**
  一份 LLM 配置的最终生效值：每个字段都是「GUI 运行时覆盖 → .env → 该协议默认」三层回落后的结果，
  所以这个结构本身不带来源信息——GUI 要知道哪些是回落值，由路由另外下发 .env 预设。
  */
export interface ResolvedLlmConfig {
  /** 空串 = 一个都没配（此时 createLlmProvider 返回 undefined，调用方走本地启发式） */
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

function createProvider(config: ResolvedLlmConfig): LlmProvider | undefined {
  const { provider, model, baseUrl, apiKey, timeoutMs } = config;
  if (provider === "anthropic") {
    if (!apiKey) return undefined;
    return new RetryLlmProvider(new AnthropicProvider({ endpoint: baseUrl, apiKey, model, timeoutMs }));
  }
  if (provider === "ollama") return new RetryLlmProvider(new OllamaTeachingProvider({ endpoint: baseUrl, model, timeoutMs }));
  if (provider === "openai" || provider === "openai-compatible") {
    // 官方 openai 协议没有 key 必然 401，直接不建实例；兼容端点（Ollama/LM Studio 的 OpenAI 层）允许无 key 本地跑
    if (provider === "openai" && !apiKey) return undefined;
    return new RetryLlmProvider(new OpenAICompatibleProvider({ endpoint: baseUrl, apiKey, model, timeoutMs }));
  }
  return undefined;
}

/**
  唯一的 LLM 工厂（2026-09-18 起不再有「轻量 / 主力」两套配置）：
  .env 只有一套 `TUTOR_LLM_*`；「轻任务 / 教学对话」是**运行时角色**（差别只在思考开关，见 llm/runtime.ts），
  不是两份配置。旧别名 `TUTOR_TEACHING_*` 与 `TUTOR_OPENAI_API_KEY` / `TUTOR_ANTHROPIC_API_KEY` 已于 10-18 停止读取
  ——同一扇门两把钥匙，配错一把会读成另一份配置，而且账面看不出来。
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
