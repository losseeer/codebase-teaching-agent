import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JournalEvent, JournalEventType } from "@codebase-tutor/domain";
import { isJournalEventType } from "@codebase-tutor/domain";

import { id } from "@codebase-tutor/platform";
import { currentTraceId } from "@codebase-tutor/platform";

export class Journal {
  private readonly file: string;

  constructor(repositoryPath: string, readonly repositoryId: string) {
    const directory = join(repositoryPath, ".tutor");
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "journal.jsonl");
  }

  append(type: JournalEventType, payload: JournalEvent["payload"], sessionId?: string, traceId?: string | null): JournalEvent {
    if (!isJournalEventType(type)) throw new Error(`Unknown journal event: ${type}`);
    const event: JournalEvent = {
      id: id(),
      type,
      at: new Date().toISOString(),
      repositoryId: this.repositoryId,
      sessionId,
      // 未传时取当前请求上下文；显式传 null 则记 null
      traceId: traceId === undefined ? currentTraceId() : traceId,
      payload
    };
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }
}

/** 按库路径交出一条审计线的写入口与读入口；未挂载的仓也可按路径记。 */
export function auditLineFor(repositoryPath: string, repositoryId: string) {
  const journal = new Journal(repositoryPath, repositoryId);
  return {
    append: (type: JournalEventType, payload: JournalEvent["payload"], sessionId?: string) => journal.append(type, payload, sessionId),
    read: () => readJournal(repositoryPath)
  };
}

/** 按字节水位增量解析 journal 的读缓存；append-only，已解析前缀不重读。 */
interface JournalReadEntry {
  ino: number;
  /** 长度相同时用它分辨等长改写。 */
  mtimeMs: number;
  /** 已读到的字节偏移，含未凑成整行的尾部。 */
  read: number;
  events: JournalEvent[];
  /** 未凑成整行的尾部字节。 */
  pending: Buffer;
}

const journalReadCache = new Map<string, JournalReadEntry>();
const JOURNAL_READ_CACHE_MAX = 4;

/** 一段字节 → 完整行的事件列表 + 未凑成整行的尾部；坏行跳过并计入已读。 */
function parseChunk(chunk: Buffer): { events: JournalEvent[]; pending: Buffer } {
  const cut = chunk.lastIndexOf(0x0a);
  if (cut < 0) return { events: [], pending: chunk };
  const events: JournalEvent[] = [];
  for (const line of chunk.subarray(0, cut + 1).toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
    } catch {
      // 坏行不是事件，但水位照样前进
    }
  }
  return { events, pending: chunk.subarray(cut + 1) };
}

/** 从指定字节偏移读取给定长度。 */
function readRange(file: string, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  const handle = openSync(file, "r");
  try {
    return buffer.subarray(0, readSync(handle, buffer, 0, length, position));
  } finally {
    closeSync(handle);
  }
}

function remember(file: string, entry: JournalReadEntry): JournalReadEntry {
  journalReadCache.delete(file);
  journalReadCache.set(file, entry);
  while (journalReadCache.size > JOURNAL_READ_CACHE_MAX) {
    const oldest = journalReadCache.keys().next().value as string;
    journalReadCache.delete(oldest);
  }
  return entry;
}

export function readJournal(repositoryPath: string): JournalEvent[] {
  const file = join(repositoryPath, ".tutor", "journal.jsonl");
  const reload = (ino: number, mtimeMs: number): JournalEvent[] => {
    const whole = readFileSync(file);
    const parsed = parseChunk(whole);
    return remember(file, { ino, mtimeMs, read: whole.length, events: parsed.events, pending: parsed.pending }).events.slice();
  };
  let size: number;
  let ino: number;
  let mtimeMs: number;
  try {
    const stat = statSync(file);
    size = stat.size;
    ino = stat.ino;
    mtimeMs = stat.mtimeMs;
  } catch {
    journalReadCache.delete(file);
    return [];
  }
  const cached = journalReadCache.get(file);
  if (cached && cached.ino === ino && size >= cached.read) {
    if (size === cached.read) {
      // 长度未变时，mtime 也未变才算没变；mtime 变了按等长改写处理
      if (cached.mtimeMs === mtimeMs) return remember(file, cached).events.slice();
      return reload(ino, mtimeMs);
    }
    // 只读没碰过的那一段，并接上上一轮未凑成整行的尾部
    const parsed = parseChunk(Buffer.concat([cached.pending, readRange(file, cached.read, size - cached.read)]));
    return remember(file, { ino, mtimeMs, read: size, events: [...cached.events, ...parsed.events], pending: parsed.pending }).events.slice();
  }
  // inode 变化或文件截断：整份重读
  return reload(ino, mtimeMs);
}

/** journal 的行数与字节数。 */
export function journalFootprint(repositoryPath: string): { lines: number; bytes: number } {
  const file = join(repositoryPath, ".tutor", "journal.jsonl");
  try {
    return { lines: readJournal(repositoryPath).length, bytes: statSync(file).size };
  } catch {
    return { lines: 0, bytes: 0 };
  }
}
