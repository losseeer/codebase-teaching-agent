import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hash, logTargetFromEnv } from "../lib.js";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "./provider.js";
import { currentActor, currentThreadId, currentTraceId } from "../trace/context.js";

/**
  LLM 调用工作日志：每次 provider.complete 落一条记录。

  - 落盘：JSONL 追加到 `TUTOR_LLM_LOG`（默认 `~/.codebase-tutor/llm.log`）；设为 `off`/`none`/`0` 只打控制台。
  - 控制台：一行摘要，与 engine 其它日志同风格（`[llm] …`）。
  - 失败**照记**并原样抛出：日志的存在不能把失败伪装成成功（静默降级是明令禁止的）。
  - `traceId` 来自请求上下文（`trace/context.ts`），与 `engine.jsonl` 的同类字段构成关联键：
    「一次请求 → N 次 LLM 调用」靠它串起来，不再靠时间戳硬凑。
  - 覆盖范围：**凡是走 `LlmProvider` 的调用**——教学回合、map/practice 对话、出题、判分、题面润色、
    推荐入口、宏观设计命名，以及导入期的 L1 文件摘要（`LlmSummaryProvider` 包的就是轻量档，scene `map.summary`）。
    不进这条线的只有两种：确定性摘要档（轻量档没配 / 预算触顶 / `TUTOR_SUMMARY_PROVIDER=off|local`，本来就不发请求），
    和 `OllamaSummaryProvider`（自己 fetch 本机服务，不经 `LlmProvider`）。别按「摘要不算 LLM 调用」的老口径来对账
    （10-06 复审改掉的就是这句话）。

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
    有了它才能把「同一线程相邻两轮」的间隔与前缀缓存命中率对上——scene 只能给同场景相邻调用的代理值。
    数据源是 trace 上下文（`trace/context.ts` 的 markThread），不在 provider 层新增参数。
    */
  threadId: string | null;
  /**
    调用方身份（API key 的名字，见 `security/api-keys.ts`）；本机模式没配 key 文件时为 null。
    企业形态的账要能分到「哪个调用方烧了多少钱」，靠的就是这一列与 traceId 的组合。
    */
  actor: string | null;
  /**
    出境载荷指纹：这一次调用**实际发出去**的那份文本（system + user 或整条 messages + 工具清单）的
    字符数与 sha256 前 12 位。正文一个字都不进日志——但有了指纹就能事后核对：
    重新装配一次那段 prompt、比哈希，就知道「出去的是不是这份」；相邻两行哈希相同，
    就说明前缀逐字一致（前缀缓存那档的判据也落在这里）。
    */
  outbound: { chars: number; hash: string };
  tools?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  finishReason?: string;
  error?: string;
}

const DEFAULT_LOG_FILE = join(homedir(), ".codebase-tutor", "llm.log");

/** 当前日志目标文件；null = 只打控制台（`TUTOR_LLM_LOG=off`）。每次读取，便于测试用 env 切换。 */
export function llmLogPath(): string | null {
  return logTargetFromEnv(process.env.TUTOR_LLM_LOG, DEFAULT_LOG_FILE);
}

/**
  出境载荷指纹：把这一次真正要发出去的每一段文本（system、user 或整条 messages 含工具提议与工具结果、
  回传的 reasoning、以及工具 schema）拼成一个串，取字符数与哈希前 12 位。

  **为什么记指纹而不记正文**：企业侧要回答的是「那段代码有没有出门、出门的是哪一版」，
  而不是把源码再抄一份进另一台机器的日志——那等于又开一条泄露面。有了指纹，审计者可以
  在本地把同一次装配重跑一遍、比哈希，逐字确认「就是这个」；两份记录哈希相同也直接说明
  载荷一字不差（前缀缓存那档的判据就是这么来的）。
  工具 schema 也进串：它同样占输入 token，跨仓那档变长是要看得见的（§40）。
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
  const detail = record.ok ? (record.finishReason && record.finishReason !== "stop" ? ` · finish ${record.finishReason}` : "") : ` · ${record.error ?? "未知错误"}`;
  return `[llm] ${record.tier} · ${record.scene} · ${record.model} · ${record.ok ? "ok" : "fail"} · ${record.ms}ms · ${tokens} · think ${record.thinking}${tools}${detail}`;
}

/** 记录一次调用（控制台 + 落盘）。 */
export function logLlmCall(record: LlmCallRecord): void {
  console.log(formatLlmCallLine(record));
  const target = llmLogPath();
  if (target) appendLine(target, `${JSON.stringify(record)}\n`);
}

/**
  运行时包装：记录 tier 与调用方声明的 scene，其余行为原样透传。
  必须放在 ThinkingOverride **内层**（`ThinkingOverride(Logging(raw))`）：档位是包装器注入的，
  放在外层会把 input.thinking 记成调用方没写时的 "auto"，与实际下发的档位不符（日志说自动、实际关了思考）。
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
      actor: currentActor(),
      outbound: outboundFingerprint(input),
      ...(input.tools?.length ? { tools: input.tools.map((tool) => tool.name) } : {})
    };
    try {
      const completion = await this.inner.complete(input);
      logLlmCall({
        ...base,
        ok: true,
        ms: Date.now() - started,
        ...(completion.usage ? {
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          ...(completion.usage.promptCacheHitTokens === undefined ? {} : { cacheHitTokens: completion.usage.promptCacheHitTokens })
        } : {}),
        ...(completion.finishReason ? { finishReason: completion.finishReason } : {})
      });
      return completion;
    } catch (error) {
      logLlmCall({ ...base, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
