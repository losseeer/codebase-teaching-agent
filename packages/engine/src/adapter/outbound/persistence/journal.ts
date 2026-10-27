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
      // 默认取当前请求上下文；后台任务（导入期润色）与显式传 null 都记 null，不编造。
      traceId: traceId === undefined ? currentTraceId() : traceId,
      payload
    };
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }
}

/**
  按库路径交出一条审计线（写 + 读，形状见 `application/port/audit-sink.ts` 的 `AuditLine`）。
  与 `chatStoreFor` 同一处置：这里不 import 那个端口，漏一格或签名不合由注入点（`importer.audit`）的返回类型当场报错。
  未挂载的仓也要能记自己那一笔（按 threadId 找回仓、后台收尾的回合账），所以这一格只认路径与仓 id。
  */
export function auditLineFor(repositoryPath: string, repositoryId: string) {
  const journal = new Journal(repositoryPath, repositoryId);
  return {
    append: (type: JournalEventType, payload: JournalEvent["payload"], sessionId?: string) => journal.append(type, payload, sessionId),
    read: () => readJournal(repositoryPath)
  };
}

/**
  按字节水位增量解析的读缓存。依据：journal 是 append-only，已解析前缀永不改变，每行以 `\n` 收尾；
  付费分支每次都读整本再挑，全量重读重解析是纯粹重复劳动。
  防护判据写在 readJournal 的分派处（inode/截断、半行、LRU、等长改写）。
  返回的是浅拷贝：数组给调用方（sort/splice 弄不坏缓存），事件对象是共享只读数据，不许改。
  */
interface JournalReadEntry {
  ino: number;
  /** 长度没变时用它分辨「真没动」与「有人原地等长改写了一行」。 */
  mtimeMs: number;
  /** 已经碰过的文件偏移：完整行加上那半行都算（events 只含完整行，尾巴在 pending 里）。 */
  read: number;
  events: JournalEvent[];
  /** 上一轮没凑成整行的尾部字节（正常情况下为空）。 */
  pending: Buffer;
}

const journalReadCache = new Map<string, JournalReadEntry>();
const JOURNAL_READ_CACHE_MAX = 4;

/**
  一段字节 → 事件列表 + 剩下的半行。切点只认 `\n` 这一个字节，水位是精确的字节数，不会把多字节字符切两半。
  坏行跳过并算作已读。
  */
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

/** 从文件的指定字节读一段：只碰新增那截。 */
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
      // 长度没动：mtime 也没动才是「真没变」；mtime 变了是原地等长改写，接着信缓存就是拿旧事件做人家的账
      if (cached.mtimeMs === mtimeMs) return remember(file, cached).events.slice();
      return reload(ino, mtimeMs);
    }
    // 只读没碰过的那一段，并把上一轮那半行接在前面——它俩合起来才是一行
    const parsed = parseChunk(Buffer.concat([cached.pending, readRange(file, cached.read, size - cached.read)]));
    return remember(file, { ino, mtimeMs, read: size, events: [...cached.events, ...parsed.events], pending: parsed.pending }).events.slice();
  }
  // inode 变了（换文件）或长度变短（截断）：整份重读
  return reload(ino, mtimeMs);
}

/** journal 这条审计线的体量读数（挂载时进 `engine.jsonl` 一次）：只增不删，行数与字节数就是读取成本的判据。 */
export function journalFootprint(repositoryPath: string): { lines: number; bytes: number } {
  const file = join(repositoryPath, ".tutor", "journal.jsonl");
  try {
    return { lines: readJournal(repositoryPath).length, bytes: statSync(file).size };
  } catch {
    return { lines: 0, bytes: 0 };
  }
}
