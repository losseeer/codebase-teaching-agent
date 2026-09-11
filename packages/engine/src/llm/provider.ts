export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCompletionInput {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmCompletion {
  text: string;
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

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name = "OpenAI-compatible teaching model";
  readonly modelVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FetchProviderOptions) {
    this.modelVersion = `openai:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    const response = await this.request(`${this.options.endpoint.replace(/\/$/, "")}/chat/completions`, {
      model: this.options.model,
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 700,
      messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }]
    });
    const body = await response.json() as { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = contentText(body.choices?.[0]?.message?.content);
    if (!text) throw new Error("LLM returned an empty completion");
    return { text, usage: body.usage ? tokenUsage(body.usage) : undefined, finishReason: body.choices?.[0]?.finish_reason };
  }

  private async request(url: string, payload: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 12_000);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`LLM returned ${response.status}`);
      return response;
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
        lastError = error;
        if (attempt + 1 < this.attempts) await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("LLM request failed");
  }
}

function defaultModel(provider: string): string {
  if (provider === "anthropic") return "claude-3-5-sonnet-20241022";
  if (provider === "ollama") return "llama3.2";
  return "gpt-4o-mini";
}

function createProviderFromEnv(provider: string, model: string, timeoutMs: number): LlmProvider | undefined {
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.TUTOR_ANTHROPIC_API_KEY;
    if (!apiKey) return undefined;
    return new RetryLlmProvider(new AnthropicProvider({ endpoint: process.env.TUTOR_ANTHROPIC_URL ?? "https://api.anthropic.com", apiKey, model, timeoutMs }));
  }
  if (provider === "ollama") return new RetryLlmProvider(new OllamaTeachingProvider({ endpoint: process.env.TUTOR_OLLAMA_URL ?? "http://127.0.0.1:11434", model, timeoutMs }));
  if (provider === "openai" || provider === "openai-compatible") {
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.TUTOR_OPENAI_API_KEY;
    if (provider === "openai" && !apiKey) return undefined;
    return new RetryLlmProvider(new OpenAICompatibleProvider({ endpoint: process.env.TUTOR_OPENAI_URL ?? "https://api.openai.com/v1", apiKey, model, timeoutMs }));
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
  轻量档：供三个单轮轻任务使用（教学模块推荐入口 / 练习题面润色 / 课程地图命名完善）。
  - `TUTOR_LIGHT_PROVIDER` + `TUTOR_LIGHT_MODEL` 显式配置（如 ollama 本地小模型 / gpt-4o-mini）
  - 未配置时由调用方回落主力档（createTeachingProvider），保证只填一套配置也能跑通全部接入点
  - 端点与密钥变量与主力档共用（同一厂商）；超时共用 TUTOR_LLM_TIMEOUT_MS
  */
export function createLightLlmProvider(): LlmProvider | undefined {
  const provider = (process.env.TUTOR_LIGHT_PROVIDER ?? "").toLowerCase();
  if (!provider) return undefined;
  const model = process.env.TUTOR_LIGHT_MODEL ?? defaultModel(provider);
  return createProviderFromEnv(provider, model, Number(process.env.TUTOR_LLM_TIMEOUT_MS ?? 12_000));
}

export function teachingProviderStatus(provider?: LlmProvider): TeachingProviderStatus {
  return provider
    ? { provider: provider.name, model: provider.modelVersion, mode: "remote" }
    : { provider: "local deterministic fallback", model: "local-heuristic-v1", mode: "local" };
}
