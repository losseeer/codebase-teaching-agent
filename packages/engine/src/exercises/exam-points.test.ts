import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { SearchCorpus } from "../source/search-code.js";
import {
  buildPointIndex, conceptsOfTheme, kwLandings, kwTerms, matchPoint, parsePointTable, parseProbes, signalOf,
  type BodyOf, type ExamPointDef, type LandingContext
} from "./exam-points.js";

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../skills", "exercise-code-concepts");
const bundledBody: BodyOf = (name, file = "SKILL.md") => {
  if (name !== "exercise-code-concepts") return undefined;
  try { return readFileSync(join(SKILL_ROOT, file), "utf8"); } catch { return undefined; }
};

const corpus: SearchCorpus = {
  entries: [
    { path: "src/pool/ShortCodePool.java", pathWords: "src/pool/shortcodepool.java", symbols: ["ShortCodePool", "replenish", "AtomicLong"], symbolText: "shortcodepool replenish atomiclong", units: [{ name: "ShortCodePool", line: 8 }, { name: "replenish", line: 42 }, { name: "AtomicLong", line: 20 }], summary: "短码池补池" },
    { path: "src/misc/Util.java", pathWords: "src/misc/util.java", symbols: ["Util"], symbolText: "util", units: [{ name: "Util", line: 1 }], summary: "工具" }
  ]
};

const textOf: Record<string, string> = {
  "src/pool/ShortCodePool.java": [
    "class ShortCodePool {",
    "  private volatile int size;",
    "  void replenish() {",
    "    if (size < MAX) counter.incrementAndGet();",
    "    cache.invalidate(key);",
    "  }",
    "}"
  ].join("\n"),
  "src/misc/Util.java": "class Util {}\n"
};

const ctx: LandingContext = { corpus, readText: (path) => textOf[path] };

describe("考点词表解析", () => {
  it("probe 组合：& 优先于 ;，不支持嵌套", () => {
    expect(parseProbes("sym:Integer & op:Integer==; call:*.unlock ∉ finally")).toEqual([
      ["sym:Integer", "op:Integer=="], ["call:*.unlock ∉ finally"]
    ]);
  });

  it("从出厂技能读出 61 条考点，id 唯一、列齐全", () => {
    const points = parsePointTable(bundledBody);
    expect(points.length).toBe(61);
    expect(new Set(points.map((point) => point.id)).size).toBe(61);
    expect(points.every((point) => point.probes && point.concepts.length && point.point && point.tier)).toBe(true);
    expect(points.find((point) => point.id === "java.boxed-equality")?.probes).toBe("sym:Integer & op:Integer==");
  });

  it("概念词表 31 个概念，每个都被技能条目引用（无孤儿）", () => {
    const index = buildPointIndex(bundledBody);
    expect(Object.keys(index.concepts)).toHaveLength(31);
    const referenced = new Set(index.points.flatMap((point) => point.concepts));
    expect(Object.keys(index.concepts).filter((concept) => !referenced.has(concept))).toEqual([]);
    expect([...referenced].filter((concept) => !(concept in index.concepts))).toEqual([]);
  });
});

describe("概念归一与 kw 展开", () => {
  const index = buildPointIndex(bundledBody);

  it("中文主题与英文同义词都归一到同一个规范概念", () => {
    expect(conceptsOfTheme("并发", index.concepts)).toContain("并发");
    expect(conceptsOfTheme("thread-safe", index.concepts)).toContain("并发");
    expect(conceptsOfTheme("Java特性", index.concepts)).toContain("语言特性");
  });

  it("kwTerms 只出可检索的英文/符号词，不带中文", () => {
    const words = kwTerms("并发", index.concepts);
    expect(words).toContain("AtomicLong");
    expect(words).toContain("synchronized");
    expect(words.every((word) => /^[A-Za-z0-9_.-]+$/.test(word))).toBe(true);
  });
});

describe("probe 匹配器", () => {
  const point: ExamPointDef = { id: "x", concepts: [], probes: "sym:AtomicLong; text:cache", point: "", tier: "x" };

  it("sym: 命中符号表并带出行号，text: 命中原文行", () => {
    const landings = matchPoint(point, ctx);
    expect(landings.some((item) => item.path === "src/pool/ShortCodePool.java" && item.symbol === "AtomicLong" && item.line === 20)).toBe(true);
    expect(landings.some((item) => item.path === "src/pool/ShortCodePool.java" && item.line === 5)).toBe(true);
  });

  it("call:/op: 第一版不参与匹配，只描述", () => {
    expect(matchPoint({ ...point, probes: "call:ReentrantLock.lock ∉ try; op:off-by-one" }, ctx)).toEqual([]);
  });

  it("& 组内必须同时命中", () => {
    const both = matchPoint({ ...point, probes: "sym:AtomicLong & text:cache" }, ctx);
    expect(both.length).toBeGreaterThan(0);
    expect(matchPoint({ ...point, probes: "sym:AtomicLong & text:never-present" }, ctx)).toEqual([]);
  });

  it("kw: 展开同义词后任一命中即算", () => {
    const index = buildPointIndex(bundledBody);
    const landings = kwLandings("并发", index.concepts, ctx);
    expect(landings.some((item) => item.path === "src/pool/ShortCodePool.java")).toBe(true);
  });

  it("signal 给附近有控制流的行加分，孤立调用减分", () => {
    expect(signalOf(["if (x) {", "  counter.incrementAndGet();", "}"], 1)).toBeGreaterThan(0);
    expect(signalOf(["counter.incrementAndGet();"], 0)).toBeLessThan(0);
  });
});
