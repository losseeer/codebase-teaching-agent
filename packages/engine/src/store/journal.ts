import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JournalEvent, JournalEventType } from "@codebase-tutor/shared";
import { ENGINE_JOURNAL_EVENTS, UI_JOURNAL_EVENTS } from "@codebase-tutor/shared";
import { id } from "../identity.js";
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

/**
  回合文本单边落盘上限：与 `POST .../journal` 那条 HTTP 出口的 payload 字符串校验同口径（2000 字符）。
  两处数字必须一起改，所以它住在 journal 旁边而不是某个通用工具模块里。
 */
export const TURN_TEXT_LIMIT = 2_000;

/**
  `turn_text` 事件的 payload 构造（2026-09-22 拍板口径）：三种对话（teach / map_chat / practice_chat）的
  问题+回复双边原文进 journal，各截 2000 字；截断必须留痕（`*_truncated`）——丢了字要能看出来，
  与「回复达到预算上限明示」同一先例。
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
  按字节水位增量解析的读缓存。存在的理由：`summarizeCost` 挂在每一个付费分支上（一个回合可能十来次），
  而 learner 画像、journal 导出、润色复用判据也都是「读整本再挑」——文件只增不删，
  每次从第一个字节重读并重解析整本就是纯粹重复劳动（2026-10-18 实测最忙的一仓 1737 行 / 668K）。

  能安全增量靠的是两条同时成立的事实：
  - 写侧只有 `appendFileSync` 一条路（本文件），journal 是 append-only，已解析过的前缀永不改变；
  - 每行一条 JSON 且以 `\n` 收尾，所以「停在某个换行符处」的切分点是稳定的。

  三道必须自己防住的坑，缺一条就会读到错账：
  - **换文件 / 截断**：比 inode，并且只在「新长度 ≥ 水位」时才续读；变小或换 inode 一律整份重读。
    （`git checkout`、手工编辑、把仓挪走再放回来都会换 inode 或缩短，不能假装还是同一本。）
  - **半行**：写与读之间没有锁，最后一行可能刚写了一半。所以那一截的字节单独留在 `pending` 里，
    下一轮把它接在新读到的字节前面凑成完整行——既不丢行，也不会把同一半行算两次。
  - **常驻内存**：按路径留若干份（LRU），不然读过的仓越多、留下的解析结果越多。

  返回的是**浅拷贝**：数组本身给调用方（`sort`/`splice` 弄不坏缓存），事件对象仍是共享只读数据——
  调用方改了事件对象就等于改缓存，这条约束是给所有消费方的，不是提示。
  */
interface JournalReadEntry {
  ino: number;
  /** 长度没变时用它分辨「真没动」与「有人原地等长改写了一行」。 */
  mtimeMs: number;
  /**
    已经**碰过**的文件偏移：完整行加上那半行都算（`events` 只含完整行，尾巴在 `pending` 里）。
    只记这一个数就不必在两个约定之间换算——上一版就是这里错了一次，把同一半行读进两次。
    */
  read: number;
  events: JournalEvent[];
  /** 上一轮没凑成整行的尾部字节（正常情况下为空）。 */
  pending: Buffer;
}

const journalReadCache = new Map<string, JournalReadEntry>();
const JOURNAL_READ_CACHE_MAX = 4;

/**
  一段字节 → 事件列表 + 剩下的半行。切点只认 `\n` 这一个字节，所以不会有「把一个中文字符切成两半
  再各自解码」那种字节漂移：水位永远是精确的字节数。
  坏行照旧跳过（与整份读时同一口径），跳过了也算读过——不再每次重读同一行浪费力气。
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

/** 从文件的指定字节读一段：只碰新增那截，别再整本 `readFileSync`。 */
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
      // 长度一格没动：mtime 也没动才是「真没变」；mtime 变了就是有人原地等长改写了一行（测试夹具、手工编辑），
      // 那种改写把旧行换了内容，接着信缓存就是拿旧事件做人家的账
      if (cached.mtimeMs === mtimeMs) return remember(file, cached).events.slice();
      return reload(ino, mtimeMs);
    }
    // 只读没碰过的那一段，并把上一轮那半行接在前面——它俩合起来才是一行
    const parsed = parseChunk(Buffer.concat([cached.pending, readRange(file, cached.read, size - cached.read)]));
    return remember(file, { ino, mtimeMs, read: size, events: [...cached.events, ...parsed.events], pending: parsed.pending }).events.slice();
  }
  // 首次、换文件（inode 变）或被截断（长度变短）：整份重读
  return reload(ino, mtimeMs);
}

/** journal 这条审计线的体量读数（挂载时进 `engine.jsonl` 一次）：只增不删，行数与字节数就是「还能不能一直这么读」的判据。 */
export function journalFootprint(repositoryPath: string): { lines: number; bytes: number } {
  const file = join(repositoryPath, ".tutor", "journal.jsonl");
  try {
    return { lines: readJournal(repositoryPath).length, bytes: statSync(file).size };
  } catch {
    return { lines: 0, bytes: 0 };
  }
}
