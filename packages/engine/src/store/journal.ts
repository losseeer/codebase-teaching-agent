import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JournalEvent, JournalEventType } from "@codebase-tutor/domain";
import { ENGINE_JOURNAL_EVENTS, UI_JOURNAL_EVENTS } from "@codebase-tutor/domain";

import { id } from "../ids.js";
import { currentTraceId } from "../trace/context.js";

/**
  `Journal.append` 的白名单，运行时判据（`JournalEventType` 只是编译期类型）。
  两张表并起来是全集，漏归类由 shared 的编译期对账报错。读侧不校验类型：历史事件仍可读，只限制新写入。
  */
const eventTypes = new Set<JournalEventType>([...ENGINE_JOURNAL_EVENTS, ...UI_JOURNAL_EVENTS]);

/**
  界面侧可发射的那一半。`POST /api/repositories/:id/journal` 用它而不是上面的全集：
  `file_read` / `code_egress` / `token_usage` 这些引擎侧类型是审计证据，不能让被审计方自己填账。
  引擎自己写走 `Journal.append`（全集合），不受这条限制。
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

/**
  回合文本单边落盘上限：与 `POST .../journal` 的 payload 字符串校验同口径，两处数字必须一起改，
  所以它住在 journal 旁边而不是通用工具模块里。
 */
export const TURN_TEXT_LIMIT = 2_000;

/**
  `turn_text` 事件的 payload 构造：三种对话（teach / map_chat / practice_chat）的问题+回复双边原文进 journal，
  各截 TURN_TEXT_LIMIT；截断必须留痕（`*_truncated`），丢了字要能看出来。
  */
export function turnTextPayload(scene: "teach" | "map_chat" | "practice_chat", question: string, answer: string): Record<string, string | number | boolean> {
  const q = question.slice(0, TURN_TEXT_LIMIT);
  const a = answer.slice(0, TURN_TEXT_LIMIT);
  return {
    scene,
    question: q,
    question_truncated: question.length > q.length,
    answer: a,
    answer_truncated: answer.length > a.length
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
