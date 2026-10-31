/**
  模型调用这条出站口的形状：请求、回执、工具循环的消息与中止哨兵。
  只声明接口与不碰 I/O 的纯函数。
*/

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** 命中上下文缓存的 prompt token 数；端点未上报时为 undefined。 */
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

/** 发给模型的工具定义。 */
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

/** 工具循环中的消息；出现过的 reasoningContent 需原样回传。 */
export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  reasoningContent?: string;
}

/** 没写输出预算的场景共用这个缺省：按主流端点的最大输出档给。 */
export const DEFAULT_MAX_TOKENS = 8_000;

export interface LlmCompletionInput {
  system: string;
  /** 单轮调用的用户消息；有 messages 时省略。 */
  user?: string;
  /** 工具循环的既有对话；提供时忽略 user。 */
  messages?: LlmMessage[];
  tools?: LlmTool[];
  /** 输出预算；省略即取 `DEFAULT_MAX_TOKENS`。 */
  maxTokens?: number;
  temperature?: number;
  /** 思考模式档位；省略时不发思考字段。 */
  thinking?: ThinkingEffort;
  /** 调用场景标签，只写进 LLM 工作日志，不发送给端点。 */
  scene?: string;
  /** 用户停止生成时置位；SSE 断线不置位。 */
  signal?: AbortSignal;
}

/** 用户中止 LLM 调用时抛出的错误。 */
export class LlmAbortedError extends Error {
  readonly llmAborted = true;
  constructor() {
    super("LLM 调用已被中止（用户停止）");
    this.name = "LlmAbortedError";
  }
}

/** 该错误是否由中止产生：本层哨兵或 signal 已置位。 */
export function isLlmAborted(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof error === "object" && error !== null && (error as { llmAborted?: boolean }).llmAborted === true;
}

/** 思考模式档位。 */
export type ThinkingEffort = "off" | "low" | "high" | "max";

export interface LlmCompletion {
  text: string;
  toolCalls?: LlmToolCall[];
  reasoningContent?: string;
  usage?: LlmUsage;
  finishReason?: string;
  /** 拿到该结果时的尝试次数，从 1 起。 */
  attempts?: number;
  /** 每次尝试各自的墙钟（ms），按发生顺序。 */
  attemptMs?: number[];
  /** 本次调用的 max_tokens 加过一档推理余量后才成功。 */
  headroomEscalated?: boolean;
}

/** 正文被输出上限截断时给用户的尾注。 */
export const TRUNCATION_TAIL = "\n\n（回复因达到输出长度上限被截断，说「继续」可以接着讲。）";

/** 回复被截断时追加尾注。 */
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
