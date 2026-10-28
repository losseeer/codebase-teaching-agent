import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EngineTraceEvent, EngineTraceKind, TraceScalar } from "@codebase-tutor/domain";

import { logTargetFromEnv } from "./log-target.js";
import { currentTraceId } from "./context.js";
import { tutorDataDir } from "../paths.js";

/**
  引擎工作日志：记录进程活动事件，不记录对话语义；JSONL 追加到 TUTOR_ENGINE_LOG。
  对话轨迹在 journal 与 call-log 另落，靠 traceId 关联；写失败只报警告。
  */

const DEFAULT_LOG_FILE = join(tutorDataDir(), "engine.jsonl");

/** 不回显控制台的种类（http、boot 另有出口）。 */
const CONSOLE_SILENT = new Set<EngineTraceKind>(["http", "boot"]);

/** 当前日志目标文件；null = 只打控制台；每次读取以便测试切换。 */
export function engineLogPath(): string | null {
  return logTargetFromEnv(process.env.TUTOR_ENGINE_LOG, DEFAULT_LOG_FILE);
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

/** 记录一条工作日志；traceId 默认取当前上下文，后台任务显式传 null。 */
export function traceEngine(
  kind: EngineTraceKind,
  detail: Record<string, TraceScalar> = {},
  options: { traceId?: string | null; durationMs?: number; at?: string } = {}
): EngineTraceEvent {
  const event: EngineTraceEvent = {
    at: options.at ?? new Date().toISOString(),
    kind,
    traceId: options.traceId === undefined ? currentTraceId() : options.traceId,
    actor: null,
    detail
  };
  if (options.durationMs !== undefined) event.durationMs = options.durationMs;
  if (!CONSOLE_SILENT.has(kind)) console.log(formatEngineTraceLine(event));
  const target = engineLogPath();
  if (target) appendLine(target, `${JSON.stringify(event)}\n`);
  return event;
}
