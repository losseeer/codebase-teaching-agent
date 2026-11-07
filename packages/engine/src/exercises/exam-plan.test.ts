import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { SearchCorpus } from "../source/search-code.js";
import { buildPointIndex, type BodyOf, type LandingContext } from "./exam-points.js";
import { examPlanBrief, judgeThemeLandings, themeWithLandings, type ExamPlan } from "./exam-plan.js";

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../skills", "exercise-code-concepts");
const bundledBody: BodyOf = (name, file = "SKILL.md") => {
  if (name !== "exercise-code-concepts") return undefined;
  try { return readFileSync(join(SKILL_ROOT, file), "utf8"); } catch { return undefined; }
};

const index = buildPointIndex(bundledBody);

const corpus: SearchCorpus = {
  entries: [
    {
      path: "src/JavaBox.java", pathWords: "src/javabox.java", symbols: ["JavaBox", "Integer", "HashMap", "Arrays"],
      symbolText: "javabox integer hashmap arrays",
      units: [{ name: "JavaBox", line: 1 }, { name: "Integer", line: 2 }, { name: "HashMap", line: 3 }, { name: "Arrays", line: 9 }],
      summary: "包装类型比较"
    },
    {
      path: "src/Pool.java", pathWords: "src/pool.java", symbols: ["ThreadPoolExecutor", "Pool"],
      symbolText: "threadpoolexecutor pool",
      units: [{ name: "ThreadPoolExecutor", line: 4 }, { name: "Pool", line: 1 }],
      summary: "线程池参数"
    }
  ]
};

const textOf: Record<string, string> = {
  "src/JavaBox.java": [
    "class JavaBox {", "  Integer a = 1000;", "  HashMap<String,Integer> m = new HashMap<>();",
    "  void check(Integer b) {", "    if (a == b) return;", "  }", "}"
  ].join("\n"),
  "src/Pool.java": [
    "class Pool {", "  ThreadPoolExecutor executor;", "  void submit() {",
    "    if (queue.size() > cap) reject();", "  }", "}"
  ].join("\n")
};

const ctx: LandingContext = { corpus, readText: (path) => textOf[path] };

describe("主题落点三级回退", () => {
  it("第 1 级：主题命中技能条目且 probes 有落点", () => {
    const judged = judgeThemeLandings({ theme: "Java特性", index, ctx });
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;
    expect(judged.plan.sourceLevel).toBe(1);
    expect(judged.plan.concepts).toContain("语言特性");
    expect(judged.plan.pointIds).toContain("java.boxed-equality");
    expect(judged.plan.landings.every((item) => item.path)).toBe(true);
    expect(judged.plan.listedPoints.length).toBeGreaterThanOrEqual(5);
    expect(judged.plan.listedPoints.length).toBeLessThanOrEqual(10);
    // 落点按结构信号降序
    expect(judged.plan.landings[0]!.signal).toBeGreaterThanOrEqual(judged.plan.landings.at(-1)!.signal);
  });

  it("第 3 级：技能条目与概念直检都零落点就拒绝，并给替代主题", () => {
    const judged = judgeThemeLandings({ theme: "一种完全不存在的主题xyz", index, ctx });
    expect(judged.ok).toBe(false);
    if (judged.ok) return;
    expect(judged.rejection.stage).toBe("no_theme_hits");
    expect(judged.rejection.reason).toContain("没有落点");
    expect(judged.rejection.suggestions.length).toBeGreaterThan(0);
  });

  it("灰区命中不算「有落点」，但会触发第 2 级概念直检", () => {
    const theme = "线程池";
    const withoutGrey = judgeThemeLandings({ theme, index, ctx });
    // 默认全启用时，os.pool-policy 的 text:ThreadPoolExecutor 命中 -> 第 1 级
    expect(withoutGrey.ok && withoutGrey.plan.sourceLevel).toBe(1);

    const grey = judgeThemeLandings({
      theme, index, ctx,
      tiers: { grey: ["os.pool-policy"], disabled: [] }
    });
    expect(grey.ok).toBe(true);
    if (!grey.ok) return;
    // 灰区不能救成第 1 级；kw 直检靠 ThreadPoolExecutor 命中，落到第 2 级
    expect(grey.plan.sourceLevel).toBe(2);
    expect(grey.plan.pointIds).toEqual([]);
    expect(grey.plan.greyHits.length).toBeGreaterThan(0);
    expect(grey.plan.listedPoints).toHaveLength(8);
  });

  it("第 2 级清单是「全仓落点数最高的 8 条」，且 pointIds 为空", () => {
    const judged = judgeThemeLandings({
      theme: "线程池", index, ctx,
      tiers: { grey: ["os.pool-policy"] }
    });
    expect(judged.ok && judged.plan.listedPoints.length).toBe(8);
    expect(judged.ok && judged.plan.listedPoints.every((point) => point.id !== "os.pool-policy")).toBe(true);
  });
});

describe("落点概要（所有出题路径共用）", () => {
  it("第 1 级列出可考点，第 2 级带免责标注，remaining 要提示", () => {
    const judged = judgeThemeLandings({ theme: "Java特性", index, ctx });
    expect(judged.ok).toBe(true);
    if (!judged.ok || !judged.plan.listedPoints.length) return;
    const brief = examPlanBrief(judged.plan);
    expect(brief).toContain("本主题命中的可考点");
    expect(brief).toContain(judged.plan.listedPoints[0]!.id);
    const withRemaining = examPlanBrief({ ...judged.plan, remaining: 12 });
    expect(withRemaining).toContain("另有 12 处");
  });
});

describe("主题文件集合的落点兜底", () => {
  it("词法命成为空但判定有落点时，落点路径当主题文件；词法有命中时不掺入", () => {
    const judged = judgeThemeLandings({ theme: "Java特性", index, ctx });
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;
    const empty = themeWithLandings(new Set<string>(), judged.plan);
    expect(empty && [...empty]).toContain("src/JavaBox.java");
    const lexical = themeWithLandings(new Set<string>(["src/Other.java"]), judged.plan);
    expect(lexical && [...lexical]).toEqual(["src/Other.java"]);
    expect(themeWithLandings(undefined, judged.plan)).toBeUndefined();
  });
});
