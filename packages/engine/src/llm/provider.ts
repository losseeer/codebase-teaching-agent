export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
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
}

export interface LlmCompletion {
  text: string;
  toolCalls?: LlmToolCall[];
  reasoningContent?: string;
  usage?: LlmUsage;
  finishReason?: string;
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

function tokenUsage(input: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }): LlmUsage | undefined {
  const inputTokens = input.prompt_tokens ?? input.input_tokens;
  const outputTokens = input.completion_tokens ?? input.output_tokens;
  if (typeof inputTokens !== "number" && typeof outputTokens !== "number") return undefined;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
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
    */
  private readonly reasoningHeadroom: number;

  constructor(private readonly options: FetchProviderOptions) {
    this.modelVersion = `openai:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const headroom = Number(process.env.TUTOR_LLM_REASONING_HEADROOM ?? 1_500);
    this.reasoningHeadroom = Number.isFinite(headroom) && headroom > 0 ? Math.floor(headroom) : 0;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    const budget = (input.maxTokens ?? 700) + this.reasoningHeadroom;
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
    if (input.tools?.length) {
      payload.tools = input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
      payload.tool_choice = "auto";
    }
    const response = await this.request(`${this.options.endpoint.replace(/\/$/, "")}/chat/completions`, payload);
    const body = await response.json() as {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = body.choices?.[0];
    const text = contentText(choice?.message?.content);
    const toolCalls: LlmToolCall[] = (choice?.message?.tool_calls ?? []).flatMap((call) => {
      const name = call.function?.name;
      if (!name) return [];
      return [{ id: call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`, name, argumentsJson: call.function?.arguments ?? "{}" }];
    });
    if (!text && !toolCalls.length) {
      if (choice?.finish_reason === "length") {
        throw new Error(`LLM 补全被 max_tokens=${budget} 截断且正文为空：推理模型的思考 token 计入该上限。可调大 TUTOR_LLM_REASONING_HEADROOM、放宽 TUTOR_LLM_TIMEOUT_MS，或改用非推理模型。`);
      }
      throw new Error("LLM returned an empty completion");
    }
    const reasoningRaw = choice?.message?.reasoning_content;
    return {
      text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      reasoningContent: typeof reasoningRaw === "string" && reasoningRaw ? reasoningRaw : undefined,
      usage: body.usage ? tokenUsage(body.usage) : undefined,
      finishReason: choice?.finish_reason
    };
  }

  private async request(url: string, payload: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 12_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`LLM returned ${response.status}`);
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`LLM 请求超时（${timeoutMs}ms）：推理模型生成较慢时可调大 TUTOR_LLM_TIMEOUT_MS。`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
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
    const endpoint = this.options.endpoint.replace(/\/$/, "");
    const response = await this.request(`${endpoint}/v1/messages`, {
      model: this.options.model,
      max_tokens: input.maxTokens ?? 700,
      temperature: input.temperature ?? 0.2,
      system: input.system,
      messages: [{ role: "user", content: input.user }]
    });
    const body = await response.json() as { content?: unknown; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = contentText(body.content);
    if (!text) throw new Error("LLM returned an empty completion");
    return { text, usage: body.usage ? tokenUsage(body.usage) : undefined, finishReason: body.stop_reason };
  }

  private async request(url: string, payload: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 12_000);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.options.apiKey ?? "", "anthropic-version": "2023-06-01" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Anthropic returned ${response.status}`);
      return response;
    } finally {
      clearTimeout(timer);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 12_000);
    try {
      const response = await this.fetchImpl(`${this.options.endpoint.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model: this.options.model, stream: false, options: { temperature: input.temperature ?? 0.2, num_predict: input.maxTokens ?? 700 }, messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }] })
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const body = await response.json() as { message?: { content?: unknown }; prompt_eval_count?: number; eval_count?: number; done_reason?: string };
      const text = contentText(body.message?.content);
      if (!text) throw new Error("LLM returned an empty completion");
      return { text, usage: tokenUsage({ input_tokens: body.prompt_eval_count, output_tokens: body.eval_count }), finishReason: body.done_reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FailoverLlmProvider implements LlmProvider {
  readonly name: string;
  readonly modelVersion: string;
  constructor(private readonly primary: LlmProvider, private readonly fallback?: LlmProvider) {
    this.name = this.fallback ? `${primary.name} with fallback` : primary.name;
    this.modelVersion = this.fallback ? `${primary.modelVersion}|${fallback!.modelVersion}` : primary.modelVersion;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    try {
      return await this.primary.complete(input);
    } catch (error) {
      if (!this.fallback) throw error;
      const result = await this.fallback.complete(input);
      return { ...result, finishReason: result.finishReason ?? "fallback" };
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
    for (let attempt = 0; attempt < Math.max(1, this.attempts); attempt += 1) {
      try {
        return await this.primary.complete(input);
      } catch (error) {
        if (isNonRetryable(error)) throw error;
        lastError = error;
        if (attempt + 1 < this.attempts) await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("LLM request failed");
  }
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

function defaultModel(provider: string): string {
  if (provider === "anthropic") return "claude-3-5-sonnet-20241022";
  if (provider === "ollama") return "llama3.2";
  return "gpt-4o-mini";
}

/** 各协议端点/密钥的显式覆盖值（轻量档独立配置用；未提供的字段回落共用环境变量）。 */
interface ProviderEnvOverrides {
  openaiUrl?: string;
  openaiApiKey?: string;
  anthropicUrl?: string;
  anthropicApiKey?: string;
}

function createProviderFromEnv(provider: string, model: string, timeoutMs: number, overrides: ProviderEnvOverrides = {}): LlmProvider | undefined {
  if (provider === "anthropic") {
    const apiKey = overrides.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.TUTOR_ANTHROPIC_API_KEY;
    if (!apiKey) return undefined;
    return new RetryLlmProvider(new AnthropicProvider({ endpoint: overrides.anthropicUrl ?? process.env.TUTOR_ANTHROPIC_URL ?? "https://api.anthropic.com", apiKey, model, timeoutMs }));
  }
  if (provider === "ollama") return new RetryLlmProvider(new OllamaTeachingProvider({ endpoint: process.env.TUTOR_OLLAMA_URL ?? "http://127.0.0.1:11434", model, timeoutMs }));
  if (provider === "openai" || provider === "openai-compatible") {
    const apiKey = overrides.openaiApiKey ?? process.env.OPENAI_API_KEY ?? process.env.TUTOR_OPENAI_API_KEY;
    if (provider === "openai" && !apiKey) return undefined;
    return new RetryLlmProvider(new OpenAICompatibleProvider({ endpoint: overrides.openaiUrl ?? process.env.TUTOR_OPENAI_URL ?? "https://api.openai.com/v1", apiKey, model, timeoutMs }));
  }
  return undefined;
}

/** 重量级（主力）档：驱动「代码教学」多轮对话。 */
export function createTeachingProvider(): LlmProvider | undefined {
  const provider = (process.env.TUTOR_TEACHING_PROVIDER ?? process.env.TUTOR_LLM_PROVIDER ?? "").toLowerCase();
  if (!provider) return undefined;
  const model = process.env.TUTOR_TEACHING_MODEL ?? process.env.TUTOR_LLM_MODEL ?? defaultModel(provider);
  return createProviderFromEnv(provider, model, Number(process.env.TUTOR_LLM_TIMEOUT_MS ?? 12_000));
}

/**
  轻量档：供三个单轮轻任务使用（教学模块推荐入口 / 练习题面润色 / 代码地图命名完善）。
  - `TUTOR_LIGHT_PROVIDER` + `TUTOR_LIGHT_MODEL` 显式配置（如 ollama 本地小模型 / gpt-4o-mini）
  - 未配置时由调用方回落主力档（createTeachingProvider），保证只填一套配置也能跑通全部接入点
  - 端点/密钥可用独立变量（TUTOR_LIGHT_OPENAI_URL / TUTOR_LIGHT_API_KEY / TUTOR_LIGHT_ANTHROPIC_URL / TUTOR_LIGHT_ANTHROPIC_API_KEY），
    未设置时回落主力档共用变量——支持两档使用不同厂商或不同协议端点（如 GLM 资源包走 OpenAI 协议、主力档走 DeepSeek）。
  - 超时可用独立变量 TUTOR_LIGHT_TIMEOUT_MS（推理模型单轮生成可达 30-60s），未设置时回落 TUTOR_LLM_TIMEOUT_MS。
  */
export function createLightLlmProvider(): LlmProvider | undefined {
  const provider = (process.env.TUTOR_LIGHT_PROVIDER ?? "").toLowerCase().trim();
  if (!provider) return undefined;
  // 模型留空（或全空白）视为 light 档未配置 → 返回 undefined，由调用方回落主力档。
  // 不能用空模型名创建 provider：请求必然失败后被各接入点静默吞掉，表现为「LLM 失效」。
  const model = (process.env.TUTOR_LIGHT_MODEL ?? "").trim();
  if (!model) return undefined;
  const timeoutMs = Number(process.env.TUTOR_LIGHT_TIMEOUT_MS ?? process.env.TUTOR_LLM_TIMEOUT_MS ?? 12_000);
  return createProviderFromEnv(provider, model, timeoutMs, {
    openaiUrl: process.env.TUTOR_LIGHT_OPENAI_URL,
    openaiApiKey: process.env.TUTOR_LIGHT_API_KEY,
    anthropicUrl: process.env.TUTOR_LIGHT_ANTHROPIC_URL,
    anthropicApiKey: process.env.TUTOR_LIGHT_ANTHROPIC_API_KEY,
  });
}

export function teachingProviderStatus(provider?: LlmProvider): TeachingProviderStatus {
  return provider
    ? { provider: provider.name, model: provider.modelVersion, mode: "remote" }
    : { provider: "local deterministic fallback", model: "local-heuristic-v1", mode: "local" };
}
