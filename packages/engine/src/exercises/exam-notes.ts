import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
  阅读笔记（方案 v8 第 2.3 / 4 章）：段 1 定题那次输出顺手带上「读过的文件有哪些可考点」，
  校验后落进 `<repo>/.tutor/exam-points.json`，下一趟出题/读文件时再消费。
  存储与消费解耦：这里只管存与校验，打分/限流在 exam-notes-consumer 里。
*/
export const EXAM_NOTES_FILE = ".tutor/exam-points.json";
export const EXAM_NOTES_VERSION = 3;
/** 单文件笔记上限；先按 point 多样性留，再按时间裁。 */
export const MAX_NOTES_PER_FILE = 12;
const MAX_WHY = 40;

export interface ExamNote {
  path: string;
  line: number;
  symbol?: string;
  /** 技能条目 id。 */
  point: string;
  why: string;
  /** 产出这趟的主题判定级别。 */
  sourceLevel: 1 | 2;
}

export interface ExamNoteFile {
  hash: string;
  at: string;
  points: ExamNote[];
}

export interface ExamNoteStore {
  version: number;
  files: Record<string, ExamNoteFile>;
}

export interface ValidationContext {
  /** 全量合法 id（技能表里的所有考点 id）。 */
  legalIds: Set<string>;
  /** 这一趟真正读过的文件。 */
  fileReads: Set<string>;
  /** 本趟命中的技能条目 id，用于相关接受率。 */
  pointIds: Set<string>;
  sourceLevel: 1 | 2;
}

export interface ValidationResult {
  accepted: ExamNote[];
  written: number;
  /** 合法接受率 = 接受数 / 模型写的条数。 */
  legalRate: number;
  /** 相关接受率 = pointMatch=1 的接受数 / 模型写的条数（主判据）。 */
  relatedRate: number;
  rejected: number;
}

/** id 只写 slug（漏前缀）时，全局唯一才接受；否则丢弃，不猜。 */
function resolveId(raw: string, legalIds: Set<string>): string | undefined {
  const id = raw.trim();
  if (legalIds.has(id)) return id;
  const bySlug = [...legalIds].filter((legal) => legal.slice(legal.indexOf(".") + 1) === id);
  return bySlug.length === 1 ? bySlug[0] : undefined;
}

export function validateExamPoints(raw: unknown, ctx: ValidationContext): ValidationResult {
  const rows = Array.isArray(raw) ? raw : [];
  const written = rows.length;
  const accepted: ExamNote[] = [];
  let related = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    const point = typeof item.point === "string" ? resolveId(item.point, ctx.legalIds) : undefined;
    const line = Number(item.line);
    if (!path || !ctx.fileReads.has(path) || !point || !Number.isFinite(line) || line < 1) continue;
    const why = typeof item.why === "string" ? item.why.slice(0, MAX_WHY) : "";
    const symbol = typeof item.symbol === "string" && item.symbol.trim() ? item.symbol.trim().slice(0, 60) : undefined;
    accepted.push({ path, line: Math.floor(line), point, why, sourceLevel: ctx.sourceLevel, ...(symbol ? { symbol } : {}) });
    if (ctx.pointIds.has(point)) related += 1;
  }
  return {
    accepted,
    written,
    legalRate: written ? accepted.length / written : 0,
    relatedRate: written ? related / written : 0,
    rejected: written - accepted.length
  };
}

/**
  只在超过上限时才按 point 多样性裁剪：没超限时，同一考点在不同行是可以共存的
  （合并已经按 (point,line) 去过重，这里再按 point 收一道会误删合法笔记）。
*/
export function trimNotes(points: ExamNote[]): ExamNote[] {
  if (points.length <= MAX_NOTES_PER_FILE) return points;
  const byPoint = new Map<string, ExamNote>();
  for (const note of points) byPoint.set(note.point, note); // 后写胜
  const diverse = [...byPoint.values()];
  return diverse.length > MAX_NOTES_PER_FILE ? diverse.slice(-MAX_NOTES_PER_FILE) : diverse;
}

/** hash 变则整条作废；同 hash 按 (point,line) 去重合并。 */
export function mergeExamNotes(existing: ExamNoteFile | undefined, incoming: ExamNote[], hash: string, at: string): ExamNoteFile {
  const base = existing && existing.hash === hash ? existing.points : [];
  const byKey = new Map<string, ExamNote>();
  for (const note of [...base, ...incoming]) {
    const key = `${note.point}:${note.line}`;
    const previous = byKey.get(key);
    // 同 key 时保留 sourceLevel 更低的（第 1 级笔记置信度高于第 2 级）
    if (!previous || note.sourceLevel < previous.sourceLevel) byKey.set(key, note);
  }
  return { hash, at, points: trimNotes([...byKey.values()]) };
}

export function emptyStore(): ExamNoteStore {
  return { version: EXAM_NOTES_VERSION, files: {} };
}

export function loadExamNoteStore(repoPath: string): ExamNoteStore {
  try {
    const parsed = JSON.parse(readFileSync(join(repoPath, EXAM_NOTES_FILE), "utf8")) as ExamNoteStore;
    return parsed.version === EXAM_NOTES_VERSION && parsed.files ? parsed : emptyStore();
  } catch {
    return emptyStore();
  }
}

export function saveExamNoteStore(repoPath: string, store: ExamNoteStore): void {
  const file = join(repoPath, EXAM_NOTES_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/** 文件内容哈希：文件改了行号就可能全变，旧笔记整条失效。 */
export function contentHashOf(repoPath: string, path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(join(repoPath, path))).digest("hex").slice(0, 24);
  } catch {
    return undefined;
  }
}

/** 把校验后的笔记写进仓；单个文件 hash 读不到就跳过该文件（不写半份）。 */
export function recordExamNotes(repoPath: string, notes: ExamNote[], at: string): number {
  if (!notes.length) return 0;
  const store = loadExamNoteStore(repoPath);
  const byPath = new Map<string, ExamNote[]>();
  for (const note of notes) {
    const list = byPath.get(note.path) ?? [];
    list.push(note);
    byPath.set(note.path, list);
  }
  let written = 0;
  for (const [path, incoming] of byPath) {
    const hash = contentHashOf(repoPath, path);
    if (!hash) continue;
    store.files[path] = mergeExamNotes(store.files[path], incoming, hash, at);
    written += incoming.length;
  }
  if (written) {
    try { saveExamNoteStore(repoPath, store); }
    catch (error) {
      // 笔记是诊断数据：写盘失败只留痕，不能冒泡成 provider_error 把整道题判死。
      console.warn(`[exam-notes] 笔记落盘失败，本趟出题继续：${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }
  return written;
}
