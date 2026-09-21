import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalEvent, JournalEventType } from "@codebase-tutor/shared";
import { id } from "../lib.js";
import { currentTraceId } from "../trace/context.js";

/**
  `Journal.append` 的白名单，且是**运行时**判据——`JournalEventType` 只是编译期类型。
  ⚠️ 往 shared 的 `JournalEventType` 加取值时必须同步这里，否则运行期抛 `Unknown journal event`。
  */
const eventTypes = new Set<JournalEventType>([
  // 引擎侧（学习语义）
  "unit_mastered", "exercise_result", "hint_depth", "dependency_event",
  "style_shift", "teach_moment", "unassisted_test", "action_veto",
  "exercise_declined", "token_usage", "file_read", "code_search",
  // UI 侧（交互动作）：由 GUI 经 POST /api/repositories/:id/journal 写入
  "flow_node_selected", "file_anchored", "file_opened", "line_located",
  "module_switched", "exercise_submitted", "repository_switched"
]);

/** 供 HTTP 出口做入参校验：不接受白名单外的类型（走同一份白名单，不另立一份）。 */
export function isJournalEventType(value: unknown): value is JournalEventType {
  return typeof value === "string" && eventTypes.has(value as JournalEventType);
}

export class Journal {
  private readonly file: string;

  constructor(repositoryPath: string, readonly repositoryId: string) {
    const directory = join(repositoryPath, ".tutor");
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "journal.jsonl");
  }

  append(type: JournalEventType, payload: JournalEvent["payload"], sessionId?: string, traceId?: string | null): JournalEvent {
    if (!eventTypes.has(type)) throw new Error(`Unknown journal event: ${type}`);
    const event: JournalEvent = {
      id: id(),
      type,
      at: new Date().toISOString(),
      repositoryId: this.repositoryId,
      sessionId,
      // 默认取当前请求上下文；后台任务（导入期润色）与显式传 null 都记 null，不编造。
      traceId: traceId === undefined ? currentTraceId() : traceId,
      payload
    };
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }
}

export function readJournal(repositoryPath: string): JournalEvent[] {
  const file = join(repositoryPath, ".tutor", "journal.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as JournalEvent]; } catch { return []; }
  });
}
