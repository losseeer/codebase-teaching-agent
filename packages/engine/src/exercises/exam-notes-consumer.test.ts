import { describe, expect, it } from "vitest";

import { ExamNotesBudget, scoreNote, type ConsumeContext } from "./exam-notes-consumer.js";
import type { ExamNote, ExamNoteStore } from "./exam-notes.js";
import type { ExamPlan } from "./exam-plan.js";

const note = (over: Partial<ExamNote> = {}): ExamNote => ({
  path: "src/A.java", line: 3, point: "java.boxed-equality", why: "用 == 比包装类型", sourceLevel: 1, ...over
});

const plan: ExamPlan = {
  sourceLevel: 1, concepts: ["语言特性"], pointIds: ["java.boxed-equality"],
  landings: [{ path: "src/A.java", pointId: "java.boxed-equality", line: 3, signal: 3 }],
  remaining: 0, listedPoints: [], greyHits: []
};

const storeOf = (notes: ExamNote[]): ExamNoteStore => ({
  version: 3,
  files: { "src/A.java": { hash: "h", at: "2026-11-07T00:00:00Z", points: notes } }
});

const ctxOf = (store: ExamNoteStore, over: Partial<ConsumeContext> = {}): ConsumeContext => ({
  plan, store, candidatePaths: new Set(["src/A.java"]), themeWords: ["boxed"], theme: "Java特性", ...over
});

describe("消费打分", () => {
  it("score = 3×pointMatch + 2×fileCandidate + 1×symbolMatch", () => {
    const ctx = ctxOf(storeOf([]));
    expect(scoreNote(note({ symbol: "boxedValue" }), ctx)).toBe(6);
    expect(scoreNote(note({ path: "src/Other.java" }), ctx)).toBe(3);
    expect(scoreNote(note({ point: "os.lock-pairing" }), ctx)).toBe(2);
  });
});

describe("段 1 user 消费", () => {
  it("pointMatch=0 一律不展示，按主题记丢弃", () => {
    const store = storeOf([note(), note({ point: "os.lock-pairing", line: 9 })]);
    const budget = new ExamNotesBudget(ctxOf(store));
    expect(budget.forUser()).toHaveLength(1);
    expect(budget.diagnostics().droppedByPointMatch["Java特性"]).toBe(1);
  });

  it("阈值 3，全趟最多 12 条", () => {
    const many = Array.from({ length: 20 }, (_, index) => note({ line: index + 1 }));
    const budget = new ExamNotesBudget(ctxOf(storeOf(many)));
    expect(budget.forUser()).toHaveLength(12);
  });

  it("第三指标来自 read_file 阈值 4：相关但 score=3 的笔记被挡掉要计数", () => {
    // pointMatch=1 (3 分) + 无候选文件 + 无符号匹配 = 3 < 4
    const store: ExamNoteStore = {
      version: 3,
      files: { "src/Other.java": { hash: "h", at: "2026-11-07T00:00:00Z", points: [note({ path: "src/Other.java", symbol: undefined })] } }
    };
    const budget = new ExamNotesBudget(ctxOf(store));
    expect(budget.forRead("src/Other.java")).toEqual([]);
    expect(budget.diagnostics().droppedByThreshold).toBe(1);
  });

  it("段 1 阈值 3 侧：相关笔记恒能过（score≥3）", () => {
    const store = storeOf([note({ path: "src/Other.java", symbol: undefined })]);
    // pointMatch=1 (3 分) 本身就 >=3，这里构造 pointMatch=0 的相关笔记不存在；
    // 直接验证低分笔记不会混进展示列表
    const budget = new ExamNotesBudget(ctxOf(store));
    expect(budget.forUser()).toHaveLength(1);
    expect(budget.diagnostics().droppedByThreshold).toBe(0);
  });
});

describe("read_file 附注限流", () => {
  it("score≥4 才附注，每文件 ≤2 条，同一文件只附一次", () => {
    const store = storeOf([note({ symbol: "boxedValue" }), note({ line: 5, symbol: "boxedValue" }), note({ line: 7, symbol: "boxedValue" })]);
    const budget = new ExamNotesBudget(ctxOf(store));
    const first = budget.forRead("src/A.java");
    expect(first).toHaveLength(2);
    expect(first[0]!.length).toBeLessThanOrEqual(80);
    expect(budget.forRead("src/A.java")).toEqual([]);
  });

  it("pointMatch=0 或 score<4 不附注", () => {
    const store = storeOf([note({ point: "os.lock-pairing" }), note({ path: "src/Other.java" })]);
    const budget = new ExamNotesBudget(ctxOf(store));
    expect(budget.forRead("src/A.java")).toEqual([]);
  });

  it("单趟总预算 8 条", () => {
    const files: ExamNoteStore["files"] = {};
    for (let i = 0; i < 10; i += 1) {
      files[`src/F${i}.java`] = { hash: "h", at: "2026-11-07T00:00:00Z", points: [note({ path: `src/F${i}.java`, symbol: "boxedValue" }), note({ path: `src/F${i}.java`, line: 4, symbol: "boxedValue" })] };
    }
    const budget = new ExamNotesBudget(ctxOf({ version: 3, files }));
    let total = 0;
    for (let i = 0; i < 10; i += 1) total += budget.forRead(`src/F${i}.java`).length;
    expect(total).toBe(8);
  });
});
