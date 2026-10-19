import type { CourseNode, CourseTree } from "@codebase-tutor/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPREHENSION_MODULE_ID,
  courseModules,
  loadActiveModule,
  loadModuleOverrides,
  loadPracticeModules,
  mergeModules,
  readLegacyTierOverrides,
  saveActiveModule,
  saveModuleOverrides,
  savePracticeModules
} from "./local-state";

/**
  业务模块清单的投影与本地覆盖层。
  真源在引擎（档位、覆盖层都由 /course 叠好交出来），这里只验界面不改写、不臆造。
 */

const node = (id: string, title: string, anchors: string[], children: CourseNode[] = [], extra: Partial<CourseNode> = {}): CourseNode => ({
  id,
  title,
  summary: `${title} 的摘要`,
  kind: children.length ? "module" : "implementation",
  anchors: anchors.map((path) => ({ path, line: 1, label: path.split("/").at(-1) ?? path })),
  children,
  ...extra
});

const tree = (modules: CourseNode[]): CourseTree => ({
  repositoryId: "repo_x",
  modelVersion: "none",
  generatedAt: "2026-10-18T00:00:00.000Z",
  root: node("root", "仓库", [], [node("modules", "仓库模块地图", [], modules), node("entries", "入口", [], [])])
});

/** 可控的 localStorage 替身：存储写不进去时界面也不该崩。 */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, value)
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("课程树 → 模块清单", () => {
  it("树没到（空仓、还没导入完）给空清单，不猜一个模块出来", () => {
    expect(courseModules(undefined)).toEqual([]);
    expect(courseModules(null)).toEqual([]);
    expect(courseModules(tree([]))).toEqual([]);
  });

  it("文件清单按 path 去重、先到先得（深度优先访问序）：共享文件只挂在第一个经过它的节点上", () => {
    const modules = courseModules(tree([
      node("pay", "支付", ["Pay.java"], [
        node("pay.service", "支付服务", ["PayService.java"], [node("pay.impl", "支付实现", ["PayImpl.java", "Result.java"])]),
        node("pay.dto", "传输对象", ["Result.java"]),
        node("pay.share", "共享返回体", ["Result.java"])
      ])
    ]));
    expect(modules[0]?.entries?.map((entry) => entry.path)).toEqual(["Pay.java", "PayService.java", "PayImpl.java", "Result.java"]);
    expect(modules[0]?.entries?.find((entry) => entry.path === "Result.java")?.id).toBe("pay.impl");
  });

  it("一个节点的第二条以后锚点也进清单：那同样是这个模块的文件（去重仍按 path）", () => {
    const [only] = courseModules(tree([node("a", "甲", ["A.java", "B.java", "A.java"])]));
    expect(only?.entries?.map((entry) => entry.path)).toEqual(["A.java", "B.java"]);
    expect(only?.entries?.map((entry) => entry.id)).toEqual(["a", "a"]);
  });

  it("档位与「引擎原判」原样带出：引擎没给 tierGiven 就等于没人工改过，界面不自己补一个", () => {
    const [untouched] = courseModules(tree([node("a", "主链路", ["a.ts"], [], { tier: "core" })]));
    expect(untouched?.tier).toBe("core");
    expect(untouched?.tierGiven).toBe("core");
    expect(untouched?.tierOverridden).toBeUndefined();
    const [moved] = courseModules(tree([node("b", "设施", ["b.ts"], [], { tier: "facility", tierGiven: "core", tierOverridden: true })]));
    expect(moved).toMatchObject({ tier: "facility", tierGiven: "core", tierOverridden: true });
  });
});

describe("覆盖层合并", () => {
  const three = courseModules(tree([node("a", "甲", ["a.ts"]), node("b", "乙", ["b.ts"]), node("c", "丙", ["c.ts"])]));

  it("隐藏的整个不出、改名的只换显示名（id 仍是树节点 id，缓存与埋点按它走）", () => {
    const merged = mergeModules(three, { renamed: { b: "乙改名" }, hidden: ["c"], custom: [{ id: "mine", label: "我的主题", hint: "自圈" }] });
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "mine"]);
    expect(merged[1]?.label).toBe("乙改名");
    expect(merged[0]?.label).toBe("甲");
  });

  it("自建模块排在后面、标 custom，且不带 entries——它没有树结构背书", () => {
    const custom = mergeModules([], { renamed: {}, hidden: [], custom: [{ id: "mine", label: "我的主题", hint: "自圈" }] })[0];
    expect(custom).toEqual({ id: "mine", label: "我的主题", hint: "自圈", custom: true });
    expect(custom?.entries).toBeUndefined();
  });

  it("树里的模块 id 与自建撞名时两个都留下：不自作主张删掉用户的主题", () => {
    expect(mergeModules(three, { renamed: {}, hidden: [], custom: [{ id: "a", label: "也叫 a", hint: "" }] }).map((item) => item.id)).toEqual(["a", "b", "c", "a"]);
  });
});

describe("本地存储里的坏形状", () => {
  it("键里是坏 JSON、是数组、是字符串都不带崩：一律回落到「没有覆盖层」", () => {
    for (const junk of ["{", "[1,2]", '"改名"', "null"]) localStorage.setItem(`codebase-tutor.renamed-modules.repo_x`, junk);
    expect(loadModuleOverrides("repo_x")).toEqual({ renamed: {}, hidden: [], custom: [] });
  });

  it("hidden 里的非字符串、custom 里缺 label 的条目都丢掉，合法的那些留着", () => {
    localStorage.setItem("codebase-tutor.hidden-modules.repo_x", JSON.stringify(["a", 7, null, "b"]));
    localStorage.setItem("codebase-tutor.modules.repo_x", JSON.stringify([{ id: "ok", label: "行", hint: "h" }, { id: "nope" }, "字符串"]));
    const loaded = loadModuleOverrides("repo_x");
    expect(loaded.hidden).toEqual(["a", "b"]);
    expect(loaded.custom).toEqual([{ id: "ok", label: "行", hint: "h" }]);
  });

  it("旧版手动改档只认那三档：不认识的值不迁给服务端", () => {
    localStorage.setItem("codebase-tutor.module-tiers.repo_x", JSON.stringify({ a: "core", b: "随便写的档", c: "periphery", d: 3 }));
    expect(readLegacyTierOverrides("repo_x")).toEqual({ a: "core", c: "periphery" });
  });

  it("写进去再读出来是同一份覆盖层（改名与隐藏换了浏览器会丢，但在本机得存住）", () => {
    saveModuleOverrides("repo_x", { renamed: { a: "甲" }, hidden: ["b"], custom: [{ id: "m", label: "主题", hint: "h" }] });
    expect(loadModuleOverrides("repo_x")).toEqual({ renamed: { a: "甲" }, hidden: ["b"], custom: [{ id: "m", label: "主题", hint: "h" }] });
  });
});

describe("上次停在哪个模块", () => {
  const modules = [{ id: "a", label: "甲", hint: "" }, { id: "b", label: "乙", hint: "" }];

  it("存过的还在就用它；被隐藏或树里没了就回落第一个，不停在一个不存在的模块上", () => {
    saveActiveModule("teaching", "repo_x", "b");
    expect(loadActiveModule("teaching", "repo_x", modules)).toBe("b");
    expect(loadActiveModule("teaching", "repo_x", [modules[0]])).toBe("a");
    expect(loadActiveModule("teaching", "repo_x", [])).toBe("");
  });

  it("教学侧与练习侧各存各的，互不覆盖", () => {
    saveActiveModule("teaching", "repo_x", "a");
    saveActiveModule("practice", "repo_x", COMPREHENSION_MODULE_ID);
    expect(loadActiveModule("teaching", "repo_x", modules)).toBe("a");
    expect(localStorage.getItem("codebase-tutor.module.practice.repo_x")).not.toBeNull();
  });
});

describe("练习侧模块", () => {
  it("固定那道「程序理解题」永远在第一位，删不掉也存不进去", () => {
    savePracticeModules([{ id: "topic", label: "并发", hint: "", custom: true }]);
    const list = loadPracticeModules();
    expect(list.map((item) => item.id)).toEqual([COMPREHENSION_MODULE_ID, "topic"]);
    expect(list[0]?.custom).toBeUndefined();
  });

  it("回给界面的固定项是副本：改它不会污染下一次读出来的清单", () => {
    const first = loadPracticeModules()[0];
    if (first) first.label = "被改坏了";
    expect(loadPracticeModules()[0]?.label).toBe("程序理解题");
  });

  it("存储里混进来的非自建项（缺 id / custom 不为 true）一概不收", () => {
    localStorage.setItem("codebase-tutor.practice-modules", JSON.stringify([{ id: "x", label: "行", custom: true }, { id: "y", label: "没标 custom" }, { label: "没 id", custom: true }, 5]));
    expect(loadPracticeModules().map((item) => item.id)).toEqual([COMPREHENSION_MODULE_ID, "x"]);
  });
});
