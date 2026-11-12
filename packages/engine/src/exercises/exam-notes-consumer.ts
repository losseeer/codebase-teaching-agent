import type { ExamPlan } from "./exam-plan.js";
import type { ExamNote, ExamNoteStore } from "./exam-notes.js";

/**
  阅读笔记的消费侧（方案 v8 第 5 章）。存储与消费解耦：这里只管打分、限流、丢弃计数。
  有状态：单趟 read_file 附注预算 8 条、同一文件只附一次，状态随一次出题的 faces 存活。
*/
export interface ConsumeContext {
  plan: ExamPlan;
  store: ExamNoteStore;
  /** 本趟候选文件（selectTagCandidates / 落点判定命中的路径）。 */
  candidatePaths: Set<string>;
  /** 主题词（小写），用于 symbolMatch。 */
  themeWords: string[];
  theme: string;
}

export const USER_THRESHOLD = 3;
export const READ_THRESHOLD = 4;
export const MAX_USER_NOTES = 12;
export const MAX_READ_NOTES_PER_TRIP = 8;
export const MAX_READ_NOTES_PER_FILE = 2;
const MAX_RENDER = 80;

/** score = 3×pointMatch + 2×fileCandidate + 1×symbolMatch；pointMatch=0 一律不展示。 */
export function scoreNote(note: ExamNote, ctx: ConsumeContext): number {
  const pointMatch = ctx.plan.pointIds.includes(note.point) ? 1 : 0;
  const fileCandidate = ctx.candidatePaths.has(note.path) ? 1 : 0;
  const symbolMatch = note.symbol && ctx.themeWords.some((word) => note.symbol!.toLowerCase().includes(word)) ? 1 : 0;
  return 3 * pointMatch + 2 * fileCandidate + 1 * symbolMatch;
}

function noteLine(note: ExamNote): string {
  const text = `第 ${note.line} 行 ${note.symbol ?? ""} ${note.why}`.trim();
  return text.slice(0, MAX_RENDER);
}

export class ExamNotesBudget {
  private readShown = 0;
  private annotated = new Set<string>();
  /** 被 pointMatch=0 丢弃的笔记：按主题计数，供诊断第 2 级主题质量。 */
  readonly droppedByPointMatch: Record<string, number> = {};
  /** 被阈值挡掉的相关笔记数，供阈值调参。 */
  droppedByThreshold = 0;

  constructor(private readonly ctx: ConsumeContext) {}

  /** 段 1 的 user：pointMatch=1 且 score≥3，全趟 ≤12 条。 */
  forUser(): ExamNote[] {
    const all = Object.values(this.ctx.store.files).flatMap((entry) => entry.points);
    const scored = all.map((note) => ({ note, score: scoreNote(note, this.ctx), related: this.ctx.plan.pointIds.includes(note.point) }));
    for (const item of scored) {
      if (!item.related) this.droppedByPointMatch[this.ctx.theme] = (this.droppedByPointMatch[this.ctx.theme] ?? 0) + 1;
    }
    const kept = scored.filter((item) => item.related && item.score >= USER_THRESHOLD);
    return kept.sort((left, right) => right.score - left.score).slice(0, MAX_USER_NOTES).map((item) => item.note);
  }

  /** read_file 附注：score≥4、每文件 ≤2 条、单趟 ≤8 条、同一文件只附一次。 */
  forRead(path: string): string[] {
    if (this.annotated.has(path) || this.readShown >= MAX_READ_NOTES_PER_TRIP) return [];
    const notes = this.ctx.store.files[path]?.points ?? [];
    const related = notes.filter((note) => this.ctx.plan.pointIds.includes(note.point));
    this.droppedByThreshold += related.filter((note) => scoreNote(note, this.ctx) < READ_THRESHOLD).length;
    const kept = related
      .map((note) => ({ note, score: scoreNote(note, this.ctx) }))
      .filter((item) => item.score >= READ_THRESHOLD)
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_READ_NOTES_PER_FILE);
    if (!kept.length) return [];
    this.annotated.add(path);
    const room = MAX_READ_NOTES_PER_TRIP - this.readShown;
    const shown = kept.slice(0, room);
    this.readShown += shown.length;
    return shown.map((item) => noteLine(item.note));
  }

  /** 段 1 user 里给模型看的笔记块；空时返回空串（不静默塞空对象）。 */
  renderUserNotes(notes: ExamNote[]): string {
    if (!notes.length) return "";
    const lines = notes.slice(0, MAX_USER_NOTES).map((note) => `- ${note.path}:${note.line} [${note.point}] ${note.why}`);
    return `已分析过的文件里，与本次主题相关的可考点（写题面时可直接用，不必重复检索）：\n${lines.join("\n")}`;
  }

  renderReadNotes(lines: string[]): string {
    return lines.length ? `（这份文件上次分析出的可考点：${lines.join("；")}）` : "";
  }

  diagnostics(): { droppedByPointMatch: Record<string, number>; droppedByThreshold: number; readShown: number } {
    return { droppedByPointMatch: { ...this.droppedByPointMatch }, droppedByThreshold: this.droppedByThreshold, readShown: this.readShown };
  }
}
