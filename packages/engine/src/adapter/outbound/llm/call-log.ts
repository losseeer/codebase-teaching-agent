import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hash } from "@codebase-tutor/platform";
import { logTargetFromEnv } from "@codebase-tutor/platform";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../../../application/port/llm-provider.js";
import { currentThreadId, currentTraceId } from "@codebase-tutor/platform";
import { tutorDataDir } from "@codebase-tutor/platform";

/** LLM 调用日志：每次 `provider.complete` 落一条 JSONL，追加到 `TUTOR_LLM_LOG`。
    该变量设为 off/none/0 时只打控制台；失败照记并原样抛出。 */

export type LlmCallTier = "teaching" | "light";

export interface LlmCallRecord {
  /** ISO 时间戳 */
  at: string;
  tier: LlmCallTier;
  /** 场景标签；未声明为 `"unspecified"`。 */
  scene: string;
  provider: string;
  model: string;
  ok: boolean;
  /** 墙钟耗时（ms）。 */
  ms: number;
  thinking: string;
  /** 触发本次调用的请求 traceId；后台任务为 null。 */
  traceId: string | null;
  /** 会话线程 id；无线程的调用与后台任务为 null。 */
  threadId: string | null;
  /** 调用方身份；恒为 null。 */
  actor: string | null;
  /** 出网载荷指纹：实际发出的文本字符数与哈希前 12 位。 */
  outbound: { chars: number; hash: string };
  tools?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  finishReason?: string;
  error?: string;
  /** 第几次尝试产生该记录；1 = 一次成功或失败。 */
  attempts?: number;
  /** 每次尝试各自的墙钟（ms）。 */
  attemptMs?: number[];
  /** 该次调用经过推理预算升档。 */
  headroomEscalated?: true;
}

/** 从结果或错误对象上取尝试次数与每次耗时。 */
function attemptStats(value: unknown): { attempts?: number; attemptMs?: number[] } {
  const record = value as { attempts?: unknown; attemptMs?: unknown } | undefined;
  const attempts = typeof record?.attempts === "number" && record.attempts >= 1 ? Math.trunc(record.attempts) : undefined;
  const attemptMs = Array.isArray(record?.attemptMs) ? record.attemptMs.filter((ms): ms is number => typeof ms === "number") : undefined;
  return { ...(attempts === undefined ? {} : { attempts }), ...(attemptMs?.length ? { attemptMs } : {}) };
}

const DEFAULT_LOG_FILE = join(tutorDataDir(), "llm.log");

/** 当前日志目标文件；null = 只打控制台。 */
export function llmLogPath(): string | null {
  return logTargetFromEnv(process.env.TUTOR_LLM_LOG, DEFAULT_LOG_FILE);
}

/** 出网载荷指纹：把本次要发出的所有文本拼成一串，取字符数与哈希前 12 位。 */
export function outboundFingerprint(input: LlmCompletionInput): { chars: number; hash: string } {
  const blocks: string[] = [`system\u0000${input.system}`];
  const messages = input.messages ?? (input.user === undefined ? [] : [{ role: "user" as const, content: input.user }]);
  for (const message of messages) {
    blocks.push(`${message.role}\u0000${message.content}`);
    for (const call of message.toolCalls ?? []) blocks.push(`tool_call\u0000${call.name}\u0000${call.argumentsJson}`);
    if (message.reasoningContent) blocks.push(`reasoning\u0000${message.reasoningContent}`);
  }
  for (const tool of input.tools ?? []) blocks.push(`tool_def\u0000${tool.name}\u0000${tool.description}\u0000${JSON.stringify(tool.parameters)}`);
  const text = blocks.join("\n");
  return { chars: text.length, hash: hash(text).slice(0, 12) };
}

/** 串行写入队列：并发写入不交错，失败不中断后续写入。 */
let writeQueue: Promise<void> = Promise.resolve();

/** 等待已排队的日志写完。 */
export async function flushLlmLog(): Promise<void> {
  await writeQueue;
}

function appendLine(target: string, line: string): void {
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dirname(target), { recursive: true });
      await appendFile(target, line, "utf8");
    })
    // 日志写入失败只告警
    .catch((error: unknown) => {
      console.warn(`[llm] 日志写入失败（${target}）：${error instanceof Error ? error.message : String(error)}`);
    });
}

/** 控制台摘要行。 */
export function formatLlmCallLine(record: LlmCallRecord): string {
  const tokens = record.inputTokens === undefined && record.outputTokens === undefined
    ? "tokens n/a"
    : `in ${record.inputTokens ?? 0}${record.cacheHitTokens ? `(cache ${record.cacheHitTokens})` : ""} out ${record.outputTokens ?? 0}`;
  const tools = record.tools?.length ? ` · tools ${record.tools.join(",")}` : "";
  const retry = record.attempts && record.attempts > 1 ? ` · retry ${record.attempts}` : "";
  const detail = record.ok ? (record.finishReason && record.finishReason !== "stop" ? ` · finish ${record.finishReason}` : "") : ` · ${record.error ?? "未知错误"}`;
  return `[llm] ${record.tier} · ${record.scene} · ${record.model} · ${record.ok ? "ok" : "fail"} · ${record.ms}ms${retry} · ${tokens} · think ${record.thinking}${tools}${detail}`;
}

export function logLlmCall(record: LlmCallRecord): void {
  console.log(formatLlmCallLine(record));
  const target = llmLogPath();
  if (target) appendLine(target, `${JSON.stringify(record)}\n`);
}

/** 记录 tier 与 scene 的包装；须放在 ThinkingOverride 内层。 */
export class LoggingLlmProvider implements LlmProvider {
  readonly name: string;
  readonly modelVersion: string;

  constructor(private readonly inner: LlmProvider, private readonly tier: LlmCallTier) {
    this.name = inner.name;
    this.modelVersion = inner.modelVersion;
  }

  async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
    const started = Date.now();
    const base = {
      at: new Date(started).toISOString(),
      tier: this.tier,
      scene: input.scene ?? "unspecified",
      provider: this.name,
      model: this.modelVersion,
      thinking: input.thinking ?? "auto",
      traceId: currentTraceId(),
      threadId: currentThreadId(),
      actor: null,
      outbound: outboundFingerprint(input),
      ...(input.tools?.length ? { tools: input.tools.map((tool) => tool.name) } : {})
    };
    try {
      const completion = await this.inner.complete(input);
      logLlmCall({
        ...base,
        ok: true,
        ms: Date.now() - started,
        ...attemptStats(completion),
        ...(completion.headroomEscalated ? { headroomEscalated: true as const } : {}),
        ...(completion.usage ? {
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          ...(completion.usage.promptCacheHitTokens === undefined ? {} : { cacheHitTokens: completion.usage.promptCacheHitTokens })
        } : {}),
        ...(completion.finishReason ? { finishReason: completion.finishReason } : {})
      });
      return completion;
    } catch (error) {
      logLlmCall({ ...base, ok: false, ms: Date.now() - started, ...attemptStats(error), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
