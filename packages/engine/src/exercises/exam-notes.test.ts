import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXAM_NOTES_FILE, contentHashOf, loadExamNoteStore, mergeExamNotes, recordExamNotes, trimNotes,
  validateExamPoints, type ExamNote, type ValidationContext
} from "./exam-notes.js";

const legal = new Set(["java.boxed-equality", "java.equals-hashcode", "os.lock-pairing"]);
const ctx: ValidationContext = {
  legalIds: legal,
  fileReads: new Set(["src/A.java"]),
  pointIds: new Set(["java.boxed-equality"]),
  sourceLevel: 1
};

const note = (over: Partial<ExamNote> = {}): ExamNote => ({
  path: "src/A.java", line: 3, point: "java.boxed-equality", why: "==", sourceLevel: 1, ...over
});

describe("段 1 的 examPoints 校验", () => {
  it("合法 id / 宽松 slug 接受；非法 id、没读过的 path、坏 line 丢弃", () => {
    const result = validateExamPoints([
      { path: "src/A.java", line: 3, point: "java.boxed-equality", why: "==" },
      { path: "src/A.java", line: 4, point: "boxed-equality", why: "漏了前缀但唯一" },
      { path: "src/A.java", line: 5, point: "not.a.real.point", why: "编的" },
      { path: "src/Never.md", line: 6, point: "os.lock-pairing", why: "没读过" },
      { path: "src/A.java", line: -1, point: "os.lock-pairing", why: "行号坏" }
    ], ctx);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[1]?.point).toBe("java.boxed-equality");
    expect(result.rejected).toBe(3);
    expect(result.written).toBe(5);
  });

  it("三指标：合法接受率、相关接受率、丢弃数", () => {
    const result = validateExamPoints([
      { path: "src/A.java", line: 1, point: "java.boxed-equality", why: "相关" },
      { path: "src/A.java", line: 2, point: "os.lock-pairing", why: "合法但不相关" }
    ], ctx);
    expect(result.legalRate).toBe(1);
    expect(result.relatedRate).toBe(0.5);
    expect(result.rejected).toBe(0);
  });

  it("why 超 40 字截断，非数组输入不炸", () => {
    expect(validateExamPoints([{ path: "src/A.java", line: 1, point: "java.boxed-equality", why: "啊".repeat(80) }], ctx).accepted[0]?.why).toHaveLength(40);
    expect(validateExamPoints(undefined, ctx).accepted).toEqual([]);
  });
});

describe("笔记合并与失效", () => {
  it("hash 变整条作废；同 hash 按 (point,line) 去重合并", () => {
    const oldHash = "old-hash";
    const existing = { hash: oldHash, at: "2026-11-01T00:00:00Z", points: [note({ line: 1, why: "旧" })] };
    const changed = mergeExamNotes(existing, [note({ line: 9, why: "新" })], "new-hash", "2026-11-07T00:00:00Z");
    expect(changed.points).toHaveLength(1);
    expect(changed.points[0]?.why).toBe("新");

    const merged = mergeExamNotes(existing, [note({ line: 1, why: "重复" }), note({ line: 2, why: "新增" })], oldHash, "2026-11-07T00:00:00Z");
    expect(merged.points).toHaveLength(2);
  });

  it("超 12 条先按 point 多样性留，再按最近裁剪", () => {
    const many = Array.from({ length: 20 }, (_, index) => note({ line: index + 1, point: `p${index % 14}` }));
    const trimmed = trimNotes(many);
    expect(trimmed.length).toBeLessThanOrEqual(12);
    expect(new Set(trimmed.map((item) => item.point)).size).toBe(trimmed.length);
  });
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("落盘", () => {
  it("写入 .tutor/exam-points.json，contentHash 变后旧笔记作废", () => {
    const root = mkdtempSync(join(tmpdir(), "exam-notes-"));
    roots.push(root);
    writeFileSync(join(root, "src.java"), "class A {}\n", "utf8");
    const hash = contentHashOf(root, "src.java");
    expect(hash).toBeTruthy();
    expect(recordExamNotes(root, [note({ path: "src.java" })], "2026-11-07T00:00:00Z")).toBe(1);
    const store = loadExamNoteStore(root);
    expect(store.files["src.java"]?.hash).toBe(hash);
    expect(store.files["src.java"]?.points).toHaveLength(1);

    writeFileSync(join(root, "src.java"), "class A { int x; }\n", "utf8");
    recordExamNotes(root, [note({ path: "src.java", line: 2, why: "新" })], "2026-11-07T00:01:00Z");
    const after = loadExamNoteStore(root);
    expect(after.files["src.java"]?.hash).not.toBe(hash);
    expect(after.files["src.java"]?.points).toHaveLength(1);
    expect(after.files["src.java"]?.points[0]?.why).toBe("新");
    expect(readFileSync(join(root, EXAM_NOTES_FILE), "utf8")).toContain('"version": 3');
  });
});
