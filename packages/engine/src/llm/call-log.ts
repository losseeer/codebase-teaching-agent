import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "./provider.js";

/**
  LLM 调用工作日志：每次 provider.complete 落一条记录。

  - 落盘：JSONL 追加到 `TUTOR_LLM_LOG`（默认 `~/.codebase-tutor/llm.log`）；设为 `off`/`none`/`0` 只打控制台。
  - 控制台：一行摘要，与 engine 其它日志同风格（`[llm] …`）。
  - 失败**照记**并原样抛出：日志的存在不能把失败伪装成成功（静默降级是明令禁止的）。
  - 覆盖范围：走 `LlmProvider` 的调用（教学回合、map/practice 对话、出题、判分、题面润色、推荐入口、地图命名）。
    导入期的文件摘要走独立的 `SummaryProvider`（默认本地启发式、不发请求；Ollama 档为本机服务）**不在此列**。

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
  tools?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  finishReason?: string;
  error?: string;
}

const DEFAULT_LOG_FILE = join(homedir(), ".codebase-tutor", "llm.log");
const DISABLED = new Set(["off", "none", "0", "false"]);

/** 当前日志目标文件；null = 只打控制台（`TUTOR_LLM_LOG=off`）。每次读取，便于测试用 env 切换。 */
export function llmLogPath(): string | null {
  const raw = (process.env.TUTOR_LLM_LOG ?? "").trim();
  if (!raw) return DEFAULT_LOG_FILE;
  return DISABLED.has(raw.toLowerCase()) ? null : raw;
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
