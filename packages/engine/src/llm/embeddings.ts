import { logLlmCall } from "./call-log.js";

/**
  检索第四臂用的文本向量化（OpenAI 兼容 `/v1/embeddings`，当前按阿里云百炼 Qwen 通义向量配置）。

  为什么单独一个客户端而不塞进 `LlmProvider`：对话 provider 的接口是「消息进、文本出」，
  带工具循环、思考档位、预算降级那一整套语义；embedding 只有「文本进、向量出」，
  混在一起会让两边都长出对方不需要的分支。共用的是配置口径与 llm.log 记账线。

  只给评测台架用（`scripts/embed-repo.ts` + `phaseB:eval` 的 dense/hybrid 臂）。
  产品检索路径接不接，等四臂读数说话——同 §26/§27 的纪律。
  */

export interface EmbeddingConfig {
  /** OpenAI 兼容根路径，含 /v1，不含 /embeddings */
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

/** 单次请求条数上限：DashScope 兼容模式 v3/v4 是 10 条（v1/v2 才是 25），超了直接 400。 */
const BATCH_SIZE = 10;
/** 单条输入字符上限：模型侧是 2048 token/行，这里嵌的是文件级短文本（路径+符号+一句话职责），截断即够，不做分块。 */
const MAX_CHARS_PER_ITEM = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** 三者齐了才算配好；缺任何一项返回 undefined，调用方按「没有这一臂」处理（不是报错，是没配）。 */
export function resolveEmbeddingConfig(): EmbeddingConfig | undefined {
  const baseUrl = (process.env.TUTOR_EMBED_BASE_URL ?? "").trim();
  const apiKey = (process.env.TUTOR_EMBED_API_KEY ?? "").trim();
  const model = (process.env.TUTOR_EMBED_MODEL ?? "").trim();
  if (!baseUrl || !apiKey || !model) return undefined;
  const dimensions = Number(process.env.TUTOR_EMBED_DIMENSIONS ?? 1024) || 1024;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model, dimensions };
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /** 顺序与入参一致；任何一批失败整次抛错（脚本可重跑，向量按内容哈希缓存，不会重复花钱）。 */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** 配置由调用方 `resolveEmbeddingConfig()` 拿到再传进来：没配就整条臂不建，而不是在这里返回 undefined 让每个调用点各猜一次。 */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  return {
    model: config.model,
    dimensions: config.dimensions,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
        const batch = texts.slice(offset, offset + BATCH_SIZE).map((text) => text.slice(0, MAX_CHARS_PER_ITEM));
        const vectors = await embedBatch(config, batch);
        out.push(...vectors);
      }
      return out;
    }
  };
}

async function embedBatch(config: EmbeddingConfig, batch: string[]): Promise<Float32Array[]> {
  const startedAt = Date.now();
  const base = { at: new Date().toISOString(), tier: "light" as const, scene: "embed", provider: "openai-compatible", model: config.model, thinking: "off", traceId: null as string | null, threadId: null as string | null };
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, input: batch, dimensions: config.dimensions, encoding_format: "float" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    logLlmCall({ ...base, ok: false, ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    const message = `embedding 请求失败 ${response.status}：${text.slice(0, 200)}`;
    logLlmCall({ ...base, ok: false, ms: Date.now() - startedAt, error: message });
    throw new Error(message);
  }
  let parsed: { data?: { index?: number; embedding?: number[] }[]; usage?: { prompt_tokens?: number; total_tokens?: number } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    logLlmCall({ ...base, ok: false, ms: Date.now() - startedAt, error: "embedding 响应不是 JSON" });
    throw new Error("embedding 响应不是合法 JSON");
  }
  const rows = parsed.data ?? [];
  if (rows.length !== batch.length) throw new Error(`embedding 返回 ${rows.length} 条，请求 ${batch.length} 条`);
  // data 里的 index 是权威顺序（OpenAI 规范），不靠数组位置猜
  const ordered = [...rows].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const vectors = ordered.map((row) => Float32Array.from(row.embedding ?? []));
  if (vectors.some((vector) => vector.length === 0)) throw new Error("embedding 返回了空向量");
  logLlmCall({
    ...base, ok: true, ms: Date.now() - startedAt,
    inputTokens: parsed.usage?.prompt_tokens ?? undefined,
    // 向量输出不计 token：单价表按输入 token 计，输出记 0 而不是硬编一个数
    outputTokens: 0
  });
  return vectors;
}
