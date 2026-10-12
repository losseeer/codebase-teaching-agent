import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalEvent, JournalEventType } from "@codebase-tutor/shared";
import { ENGINE_JOURNAL_EVENTS, UI_JOURNAL_EVENTS } from "@codebase-tutor/shared";
import { id } from "../lib.js";
import { currentTraceId } from "../trace/context.js";

/**
  `Journal.append` 的白名单，且是**运行时**判据——`JournalEventType` 只是编译期类型。
  两张表并起来就是全集（shared 里有一道编译期对账，漏归类会在那里报错），
  所以这里不再手写清单：以前 shared 加一个取值就要记得同步这一行，漏了只会在用户点下按钮时抛。
  历史取值 `teach_moment` 已随 companion 功能移除（2026-09-22），**读侧不校验类型**，老仓里的旧事件仍可读，只是不再接受新写入。
  */
const eventTypes = new Set<JournalEventType>([...ENGINE_JOURNAL_EVENTS, ...UI_JOURNAL_EVENTS]);

/**
  界面侧可发射的那一半。`POST /api/repositories/:id/journal` 用它，**不用**上面那个全集：
  审计线里 `file_read` / `code_egress` / `token_usage` 这些行是「哪些代码出过门」的证据，
  而这条接口本机任何进程都调得到——照旧收引擎侧类型，等于让被审计方自己填账。
  引擎自己写还是走 `Journal.append`（全集合），不受这条限制。
  */
const uiEventTypes = new Set<string>(UI_JOURNAL_EVENTS);

export function isUiJournalEventType(value: unknown): value is JournalEventType {
  return typeof value === "string" && uiEventTypes.has(value);
}

/** 这个类型是不是「引擎专属」——只为把拒绝理由说准（未知类型与越权类型是两件事）。 */
export function isEngineOwnedEventType(value: unknown): boolean {
  return typeof value === "string" && (ENGINE_JOURNAL_EVENTS as readonly string[]).includes(value);
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
