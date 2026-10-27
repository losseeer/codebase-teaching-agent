/**
  模型调用这条出站口的形状：请求（LlmCompletionInput）、回执（LlmCompletion）、工具循环的消息与中止哨兵。
  住在这里而不是 `adapter/outbound/llm/provider.ts`，是因为**每个内层模块都要认它**——出题、摘要、教学回合、
  工具循环、判分，谁都绕不发一发请求；把它放在适配器里，那些模块就全都得伸进适配器去拿一个接口名。
  这一格保持零依赖：只声明接口与不碰任何 I/O 的纯函数（中止判定、截断尾注），不 import 任何实现方。
*/

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
