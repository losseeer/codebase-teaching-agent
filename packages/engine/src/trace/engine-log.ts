import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EngineTraceEvent, EngineTraceKind, TraceScalar } from "@codebase-tutor/shared";
import { currentTraceId } from "./context.js";

/**
  引擎工作日志：记录「引擎这个进程在干活」的事件（请求 / 导入 / 重分析 / 降级 / 启动），
  不记录对话语义——对话与教学轨迹在 `<repo>/.tutor/journal.jsonl`，两者互不依赖。

  - 落盘：JSONL 追加到 `TUTOR_ENGINE_LOG`（默认 `~/.codebase-tutor/engine.jsonl`）；设为 `off`/`none`/`0`/`false` 只打控制台。
  - 与 `llm/call-log.ts` 的分工：**LLM 调用明细只在那边落一份**（含 tokens / thinking / tools），
    本文件不重复记，两处靠 `traceId` 关联——同一事实只写一处，避免双写漂移。
  - 写失败只报警告：日志不是主流程，但也不能一声不吭（静默降级明令禁止）。
  */

const DEFAULT_LOG_FILE = join(homedir(), ".codebase-tutor", "engine.jsonl");
const DISABLED = new Set(["off", "none", "0", "false"]);

/** 不回显控制台的种类：http 已被 pino 覆盖（且 reqId 就是 traceId），boot 已有 `TUTOR_BOOT_TIMING=1` 的 `[boot]` 行。 */
const CONSOLE_SILENT = new Set<EngineTraceKind>(["http", "boot"]);

/** 当前日志目标文件；null = 只打控制台（`TUTOR_ENGINE_LOG=off`）。每次读取，便于测试用 env 切换。 */
export function engineLogPath(): string | null {
  const raw = (process.env.TUTOR_ENGINE_LOG ?? "").trim();
  if (!raw) return DEFAULT_LOG_FILE;
  return DISABLED.has(raw.toLowerCase()) ? null : raw;
}

/** 串行写入队列：并发事件不交错，单次写失败不污染后续写入。 */
let writeQueue: Promise<void> = Promise.resolve();

/** 等待已排队的日志写完（测试与关停时用）。 */
export async function flushEngineLog(): Promise<void> {
  await writeQueue;
}

function appendLine(target: string, line: string): void {
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dirname(target), { recursive: true });
      await appendFile(target, line, "utf8");
    })
    .catch((error: unknown) => {
      console.warn(`[engine] 日志写入失败（${target}）：${error instanceof Error ? error.message : String(error)}`);
    });
}

/** 控制台摘要行（导出便于测试断言格式）。 */
export function formatEngineTraceLine(event: EngineTraceEvent): string {
  const duration = typeof event.durationMs === "number" ? ` · ${event.durationMs}ms` : "";
  const trace = event.traceId ? ` · trace ${event.traceId}` : "";
  const fields = Object.entries(event.detail)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return `[engine] ${event.kind}${duration}${trace}${fields ? ` · ${fields}` : ""}`;
}

/**
  记录一条引擎工作日志。

  traceId 默认取当前请求上下文（`trace/context.ts`）；导入 / 监听刷新等后台任务显式传 null，
  并用 `detail` 里的 `job` 字段自带标识。
  */
export function traceEngine(
  kind: EngineTraceKind,
  detail: Record<string, TraceScalar> = {},
  options: { traceId?: string | null; durationMs?: number; at?: string } = {}
): EngineTraceEvent {
  const event: EngineTraceEvent = {
    at: options.at ?? new Date().toISOString(),
    kind,
    traceId: options.traceId === undefined ? currentTraceId() : options.traceId,
    detail
  };
  if (options.durationMs !== undefined) event.durationMs = options.durationMs;
  if (!CONSOLE_SILENT.has(kind)) console.log(formatEngineTraceLine(event));
  const target = engineLogPath();
  if (target) appendLine(target, `${JSON.stringify(event)}\n`);
  return event;
}
