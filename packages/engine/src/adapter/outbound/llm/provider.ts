import type { LlmUsage, LlmToolCall, LlmMessage, LlmCompletionInput, ThinkingEffort, LlmCompletion, LlmProvider, TeachingProviderStatus } from "../../../application/port/llm-provider.js";
import { LlmAbortedError, isLlmAborted } from "../../../application/port/llm-provider.js";
import { maskSecrets } from "@codebase-tutor/domain";
import { applyThinking } from "./thinking.js";

/** 出网前对 system、user、messages 过一遍密钥掩码。 */
export function screenOutbound(input: LlmCompletionInput): LlmCompletionInput {
  const system = maskSecrets(input.system);
  const user = typeof input.user === "string" ? maskSecrets(input.user) : { text: input.user, masked: 0 };
  let messageMasked = 0;
  const messages = input.messages?.map((message) => {
    const content = typeof message.content === "string" ? maskSecrets(message.content) : undefined;
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

/** 外部信号已置位时把 AbortError 换成哨兵，其余原样返回。 */
function attributeAbort(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof LlmAbortedError) return error;
  if (signal?.aborted && error instanceof Error && error.name === "AbortError") return new LlmAbortedError();
  return error;
}

/** 非 2xx 的统一出口：状态码挂到错误上，服务商回因过密钥筛后截 300 字。 */
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
  // DeepSeek thinking 模式 + tools 要求 reasoning_content 逐轮原样回传。
  if (message.reasoningContent) payload.reasoning_content = message.reasoningContent;
  return payload;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name = "OpenAI-compatible teaching model";
  readonly modelVersion: string;
  private readonly fetchImpl: typeof fetch;
  /** 推理模型的 reasoning token 计入 max_tokens，请求上限额外加一档余量；`TUTOR_LLM_REASONING_HEADROOM` 可调，0 = 关闭。 */
  private readonly reasoningHeadroom: number;

  constructor(private readonly options: FetchProviderOptions) {
    this.modelVersion = `openai:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const raw = process.env.TUTOR_LLM_REASONING_HEADROOM?.trim();
    // 空串按默认 6000；显式填 0 才是关闭
    const headroom = raw ? Number(raw) : 6_000;
    this.reasoningHeadroom = Number.isFinite(headroom) && headroom > 0 ? Math.floor(headroom) : 0;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    input = screenOutbound(input);
    const base = input.maxTokens ?? 700;
    const first = await this.attemptOnce(input, base + this.reasoningHeadroom);
    if (!first.truncated) return first.completion;
    // 截断且正文为空时按两档余量重发一次；余量为 0 时不重发，直接抛错
    if (!this.reasoningHeadroom) throw OpenAICompatibleProvider.truncatedError(base, 0, false);
    const second = await this.attemptOnce(input, base + this.reasoningHeadroom * 2);
    if (second.truncated) throw OpenAICompatibleProvider.truncatedError(base + this.reasoningHeadroom * 2, this.reasoningHeadroom, true);
    return { ...second.completion, headroomEscalated: true };
  }

  private static truncatedError(budget: number, headroom: number, escalated: boolean): Error {
    return new Error(`LLM 补全${escalated ? "两发都" : ""}被 max_tokens=${String(budget)} 截断且正文为空：推理模型的思考 token 计入这个上限。当前余量 TUTOR_LLM_REASONING_HEADROOM=${String(headroom)}——再调大它，或改用非推理模型。`);
  }

  /** 发一发并解析；截断时返回 `truncated` 而不抛。 */
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
    // 思考参数按模型能力声明组装；不支持的档位抛错
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

  /** 发一发并取回 JSON；超时与外部中止覆盖到正文读完，`dispose()` 在 `finally`。 */
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
      // 先归因外部中止，再判超时
      if (attributed instanceof LlmAbortedError) throw attributed;
      if (attributed instanceof Error && attributed.name === "AbortError") {
        throw new Error(`模型请求超时（${String(timeoutMs)}ms）：推理模型较慢时可以调大超时时长。`);
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
        // 中止优先于可重试判定；判据带 signal，不只看错误
        if (isLlmAborted(error, input.signal)) throw markAttempts(error instanceof LlmAbortedError ? error : new LlmAbortedError(), attempt + 1, attemptMs);
        if (isNonRetryable(error)) throw markAttempts(error, attempt + 1, attemptMs);
        lastError = markAttempts(error, attempt + 1, attemptMs);
        if (attempt + 1 < this.attempts) await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : markAttempts(new Error("LLM request failed"), attemptMs.length, attemptMs);
  }
}

/** 把尝试次数与每趟耗时挂到错误对象上。 */
function markAttempts(error: unknown, attempts: number, attemptMs: number[]): unknown {
  if (error instanceof Error) {
    Object.defineProperty(error, "attempts", { value: attempts, configurable: true });
    Object.defineProperty(error, "attemptMs", { value: attemptMs, configurable: true });
  }
  return error;
}

/** 确定性 4xx（除 408 / 429）不重试。 */
function isNonRetryable(error: unknown): boolean {
  const code = httpStatusOf(error);
  return code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429;
}

/** 状态码优先取错误上挂的 `httpStatus`，其次扫文案。 */
function httpStatusOf(error: unknown): number | undefined {
  const attached = (error as { httpStatus?: unknown } | null | undefined)?.httpStatus;
  if (typeof attached === "number") return attached;
  const matched = /(?:LLM returned|HTTP) (\d{3})/.exec(error instanceof Error ? error.message : String(error));
  const code = Number(matched?.[1] ?? matched?.[2]);
  return Number.isFinite(code) && matched ? code : undefined;
}

/** 给包装内 provider 的每次调用附加思考档位；`"auto"` 原样透传。 */
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

/** GUI 运行时可改的 LLM 配置覆盖：省略或空串 = 该字段回落 `.env`。 */
export interface LlmConfigOverrides {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 单次请求超时（毫秒）；空串与非法值按未填回落 `.env`。 */
  timeoutMs?: string;
}

const trimmed = (value?: string): string => value?.trim() ?? "";

/** 超时的钳制区间。 */
export const TIMEOUT_MIN_MS = 1_000;
export const TIMEOUT_MAX_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 12_000;

/** 单次请求超时：GUI 覆盖 → `.env` → 默认 12s，再钳进 `[TIMEOUT_MIN_MS, TIMEOUT_MAX_MS]`。 */
export function resolveTimeoutMs(override: string | undefined, env: string | undefined): number {
  // 取第一个读得出的正数；空串与脏串按未填处理，不当成 0
  const picked = [trimmed(override), trimmed(env)].find((raw) => Number.isFinite(Number(raw)) && Number(raw) > 0);
  const value = picked === undefined ? DEFAULT_TIMEOUT_MS : Number(picked);
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, value));
}

/** LLM 配置的三层回落：GUI 覆盖 → `.env` → 协议默认。 */
export function resolveLlmConfig(overrides: LlmConfigOverrides = {}): ResolvedLlmConfig {
  const provider = (trimmed(overrides.provider) || process.env.TUTOR_LLM_PROVIDER || "").toLowerCase();
  const baseUrl = trimmed(overrides.baseUrl);
  const apiKey = trimmed(overrides.apiKey);
  const model = trimmed(overrides.model) || process.env.TUTOR_LLM_MODEL || defaultModel();
  // 留空与非法值回落默认，不当成 0
  const timeoutMs = resolveTimeoutMs(overrides.timeoutMs, process.env.TUTOR_LLM_TIMEOUT_MS);
  return { provider, model, baseUrl: baseUrl || process.env.TUTOR_OPENAI_URL || "https://api.openai.com/v1", apiKey: apiKey || process.env.OPENAI_API_KEY, timeoutMs };
}

/** 一份 LLM 配置的最终生效值。 */
export interface ResolvedLlmConfig {
  /** 空串 = 未配置，此时 `createLlmProvider` 返回 `undefined`。 */
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

function createProvider(config: ResolvedLlmConfig): LlmProvider | undefined {
  const { provider, model, baseUrl, apiKey, timeoutMs } = config;
  if (provider === "openai" || provider === "openai-compatible") {
    // 官方 openai 协议无 key 不建实例；兼容端点允许无 key 本地跑
    if (provider === "openai" && !apiKey) return undefined;
    return new RetryLlmProvider(new OpenAICompatibleProvider({ endpoint: baseUrl, apiKey, model, timeoutMs }));
  }
  return undefined;
}

/** LLM 工厂：配置未落地时返回 `undefined`。 */
export function createLlmProvider(overrides?: LlmConfigOverrides): LlmProvider | undefined {
  const config = resolveLlmConfig(overrides);
  return config.provider ? createProvider(config) : undefined;
}

export function teachingProviderStatus(provider?: LlmProvider): TeachingProviderStatus {
  return provider
    ? { provider: provider.name, model: provider.modelVersion, mode: "remote" }
    : { provider: "local deterministic fallback", model: "local-heuristic-v1", mode: "local" };
}
