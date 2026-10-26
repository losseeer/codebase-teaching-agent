import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hash } from "@codebase-tutor/platform";
import { logTargetFromEnv } from "@codebase-tutor/platform";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "./provider.js";
import { currentThreadId, currentTraceId } from "@codebase-tutor/platform";
import { tutorDataDir } from "@codebase-tutor/platform";

/**
  LLM 调用工作日志：每次 provider.complete 落一条记录。

  - 落盘：JSONL 追加到 `TUTOR_LLM_LOG`（默认 `~/.codebase-tutor/llm.log`）；设为 off/none/0 只打控制台。
  - 控制台：一行摘要（`[llm] …`）。
  - 失败照记并原样抛出：日志不能把失败伪装成成功。
  - `traceId` 来自请求上下文（`trace/context.ts`），与 `engine.jsonl` 同类字段构成关联键，
    用来串「一次请求 → N 次 LLM 调用」，不靠时间戳硬凑。
  - 覆盖范围：凡走 `LlmProvider` 的调用。不进这条线的只有确定性摘要档（本来就不发请求）
    和 `OllamaSummaryProvider`（自己 fetch 本机服务，不经 `LlmProvider`）。

  包装位置见 LoggingLlmProvider 的注释（内层，档位注入之后）。
  */

export type LlmCallTier = "teaching" | "light";

export interface LlmCallRecord {
  /** ISO 时间戳 */
  at: string;
  tier: LlmCallTier;
  /** 调用场景标签（调用点用 `scene` 字段声明），未声明为 "unspecified" */
  scene: string;
  provider: string;
  model: string;
  ok: boolean;
  /** 墙钟耗时（ms）——仅用于观察延迟，成本口径一律看 token */
  ms: number;
  thinking: string;
  /** 触发本次调用的请求 traceId；后台任务（导入期润色）为 null。与 engine.jsonl 的关联键。 */
  traceId: string | null;
  /**
    本轮所属的会话线程 id（教学侧 = sessionId）；无线程的单次提问与后台任务为 null。
    数据源是 trace 上下文（`trace/context.ts` 的 markThread），不在 provider 层新增参数。
    */
  threadId: string | null;
  /**
    调用方身份：恒 null。字段保留是为了两份日志线的列形状稳定——历史行的这一列要读得出。
    */
  actor: string | null;
  /**
    出网载荷指纹：这一次调用实际发出去的文本的字符数与哈希前 12 位。
    为什么记指纹不记正文、事后怎么核对，见 outboundFingerprint 的注释。
    */
  outbound: { chars: number; hash: string };
  tools?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  finishReason?: string;
  error?: string;
  /**
    第几次尝试给出这个结论（1 = 一次就成/败）。重试在 Logging 内层，一次逻辑调用只落一行，
    这个值必须靠返回值/错误对象传出来。缺该字段的历史行按「未知」读，不当 1。
    */
  attempts?: number;
  /** 每次尝试各自的墙钟（ms）。`[60000, 15000]` = 第一发超时、第二发成了。 */
  attemptMs?: number[];
  /** 这一发是先被思考量挤空、又把 `max_tokens` 抬高一档才成的（`provider.ts` 的推理预算升档）。 */
  headroomEscalated?: true;
}

/** 从 provider 的结果或错误上取重试计数（RetryLlmProvider 的 markAttempts 挂的就是这两个字段）。 */
function attemptStats(value: unknown): { attempts?: number; attemptMs?: number[] } {
  const record = value as { attempts?: unknown; attemptMs?: unknown } | undefined;
  const attempts = typeof record?.attempts === "number" && record.attempts >= 1 ? Math.trunc(record.attempts) : undefined;
  const attemptMs = Array.isArray(record?.attemptMs) ? record.attemptMs.filter((ms): ms is number => typeof ms === "number") : undefined;
  return { ...(attempts === undefined ? {} : { attempts }), ...(attemptMs?.length ? { attemptMs } : {}) };
}

const DEFAULT_LOG_FILE = join(tutorDataDir(), "llm.log");

/** 当前日志目标文件；null = 只打控制台（`TUTOR_LLM_LOG=off`）。每次读取，便于测试用 env 切换。 */
export function llmLogPath(): string | null {
  return logTargetFromEnv(process.env.TUTOR_LLM_LOG, DEFAULT_LOG_FILE);
}

/**
  出网载荷指纹：把这一次真正要发出去的每一段文本（system、user 或整条 messages、工具调用与结果、
  回传的 reasoning、工具 schema）拼成一个串，取字符数与哈希前 12 位。
  记指纹不记正文：要回答的是「那段代码有没有出门、出门的是哪一版」，不该把源码再抄一份进日志新开泄露面。
  审计者在本地重跑同一次装配比哈希即可逐字确认；两份记录哈希相同也说明载荷一字不差。
  工具 schema 也进串：它同样占输入 token。
  */
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

/** 串行写入队列：并发调用不交错，单次写失败不污染后续写入。 */
let writeQueue: Promise<void> = Promise.resolve();

/** 等待已排队的日志写完（测试与关停时用）。 */
export async function flushLlmLog(): Promise<void> {
  await writeQueue;
}

function appendLine(target: string, line: string): void {
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dirname(target), { recursive: true });
      await appendFile(target, line, "utf8");
    })
    // 日志写不进去只报警告：它不是主流程，但也不能一声不吭
    .catch((error: unknown) => {
      console.warn(`[llm] 日志写入失败（${target}）：${error instanceof Error ? error.message : String(error)}`);
    });
}

/** 控制台摘要行（导出便于测试断言格式）。 */
export function formatLlmCallLine(record: LlmCallRecord): string {
  const tokens = record.inputTokens === undefined && record.outputTokens === undefined
    ? "tokens n/a"
    : `in ${record.inputTokens ?? 0}${record.cacheHitTokens ? `(cache ${record.cacheHitTokens})` : ""} out ${record.outputTokens ?? 0}`;
  const tools = record.tools?.length ? ` · tools ${record.tools.join(",")}` : "";
  // 重试只在真发生过时上屏：一次就成的行不该多一个字段
  const retry = record.attempts && record.attempts > 1 ? ` · retry ${record.attempts}` : "";
  const detail = record.ok ? (record.finishReason && record.finishReason !== "stop" ? ` · finish ${record.finishReason}` : "") : ` · ${record.error ?? "未知错误"}`;
  return `[llm] ${record.tier} · ${record.scene} · ${record.model} · ${record.ok ? "ok" : "fail"} · ${record.ms}ms${retry} · ${tokens} · think ${record.thinking}${tools}${detail}`;
}

export function logLlmCall(record: LlmCallRecord): void {
  console.log(formatLlmCallLine(record));
  const target = llmLogPath();
  if (target) appendLine(target, `${JSON.stringify(record)}\n`);
}

/**
  运行时包装：记录 tier 与调用方声明的 scene，其余行为原样透传。
  必须放在 ThinkingOverride 内层（`ThinkingOverride(Logging(raw))`）：档位由外层包装器注入，
  Logging 放外层会把实际下发的档位记成调用方没写时的 "auto"。
  */
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
