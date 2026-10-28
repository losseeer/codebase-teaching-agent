/**
  模型调用这条出站口的形状：请求、回执、工具循环的消息与中止哨兵。
  内层模块都要认它，所以住在 application 而不是 adapter。
  这一格保持零依赖：只声明接口与不碰 I/O 的纯函数。
*/

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** 命中自动上下文缓存的 prompt token 数；undefined = 端点未上报。 */
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

/** 工具定义（OpenAI function 形状的简化版）。 */
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

/** 多轮工具循环中的消息；reasoningContent 只在响应里出现时才需原样回传。 */
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
  /** 思考模式控制；省略 = 不发任何思考字段。 */
  thinking?: ThinkingEffort;
  /** 调用场景标签，只用于 LLM 工作日志；协议层不发送。 */
  scene?: string;
  /** 外部中止信号：只由用户点「停止生成」置位；SSE 断线不中止回合。 */
  signal?: AbortSignal;
}

/** 外部中止专用错误：与超时区分；重试层与降级 catch 都原样上抛。 */
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

/** 思考模式档位；各家族的真实参数格式与取值见 llm/thinking.ts 能力表。 */
export type ThinkingEffort = "off" | "low" | "high" | "max";

export interface LlmCompletion {
  text: string;
  toolCalls?: LlmToolCall[];
  reasoningContent?: string;
  usage?: LlmUsage;
  finishReason?: string;
  /** 第几次尝试拿到的这个结果（1 = 一次就成）；只有 RetryLlmProvider 会填。 */
  attempts?: number;
  /** 每次尝试各自的墙钟（ms），按发生顺序。 */
  attemptMs?: number[];
  /** 这一发的 max_tokens 加过一档推理余量后才成。 */
  headroomEscalated?: boolean;
}

/** 正文被输出上限截断时给用户的尾注。 */
export const TRUNCATION_TAIL = "\n\n（回复因达到输出长度上限被截断，说「继续」可以接着讲。）";

/** 可见回复被截断时加尾注；空文不加。 */
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
