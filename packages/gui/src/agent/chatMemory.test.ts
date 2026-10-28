import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDebtMap, readThreadMemory, RECHECK_DELAYS, writeDebtMap, writeThreadMemory } from "./chatMemory";

/**
  侧栏本地记忆：上次位置与断线轮回读记录。
  判据：坏数据不崩、不当好数据用。
 */

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
  vi.stubGlobal("sessionStorage", fakeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("线程记忆（localStorage）", () => {
  it("键是空的、是坏 JSON、是数组或字符串都回一张空表", () => {
    for (const junk of ["", "{", "null", "[1,2]", '"只有个字符串"']) {
      localStorage.setItem("codebase-tutor.teaching-sessions", junk);
      expect(readThreadMemory()).toEqual({});
    }
  });

  it("旧形状（值是字符串而不是按作用域分的对象）在这一层被认出并跳过", () => {
    localStorage.setItem("codebase-tutor.teaching-sessions", JSON.stringify({ repo_old: "上一个会话 id", repo_new: { map: { currentId: "t1", ids: ["t1"] } } }));
    const memory = readThreadMemory();
    expect(memory.repo_old).toBeUndefined();
    expect(memory.repo_new).toEqual({ map: { currentId: "t1", ids: ["t1"] } });
  });

  it("ids 里混进非字符串就丢掉，currentId 不是字符串就当没记住", () => {
    localStorage.setItem("codebase-tutor.teaching-sessions", JSON.stringify({ r: { teach: { currentId: 7, ids: ["a", 3, null, "b"] } } }));
    expect(readThreadMemory().r?.teach).toEqual({ currentId: null, ids: ["a", "b"] });
  });

  it("写进去再读回来是同一份，且不同仓、不同作用域互不覆盖", () => {
    writeThreadMemory("r1", "map", { currentId: "m1", ids: ["m1", "m0"] });
    writeThreadMemory("r1", "practice", { currentId: null, ids: [] });
    writeThreadMemory("r2", "teach", { currentId: "t9", ids: ["t9"] });
    expect(readThreadMemory()).toEqual({
      r1: { map: { currentId: "m1", ids: ["m1", "m0"] }, practice: { currentId: null, ids: [] } },
      r2: { teach: { currentId: "t9", ids: ["t9"] } }
    });
  });
});

describe("断线欠账（sessionStorage）", () => {
  it("只有 threadId 是字符串、count 是数字的那一格才留着——残缺的欠账会让补账去读一个不存在的会话", () => {
    sessionStorage.setItem("codebase-tutor.turn-debt", JSON.stringify({
      r1: { map: { threadId: "t1", count: 4 }, teach: { threadId: 7, count: 1 }, practice: { threadId: "t2", count: "3" } },
      r2: "整格都是字符串",
      r3: null
    }));
    expect(readDebtMap()).toEqual({ r1: { map: { threadId: "t1", count: 4 } } });
  });

  it("坏 JSON 回空表；写进去再读回来是同一份", () => {
    sessionStorage.setItem("codebase-tutor.turn-debt", "{ 坏掉的");
    expect(readDebtMap()).toEqual({});
    writeDebtMap({ r1: { teach: { threadId: "t9", count: 2 } } });
    expect(readDebtMap()).toEqual({ r1: { teach: { threadId: "t9", count: 2 } } });
  });

  it("存不下（禁用存储）不等于发送失败：写的时候不抛，读回来是空表", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("存储被禁用"); }, setItem: () => { throw new Error("存储被禁用"); }, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 });
    expect(() => writeDebtMap({ r1: { map: { threadId: "t1", count: 2 } } })).not.toThrow();
    expect(readDebtMap()).toEqual({});
  });

  it("回读节奏是 12s / 30s / 60s 三趟：单趟「正文没多」是常态，不能据此宣布补账失败", () => {
    expect([...RECHECK_DELAYS]).toEqual([12_000, 30_000, 60_000]);
    expect(RECHECK_DELAYS.reduce((sum, delay) => sum + delay, 0)).toBe(102_000);
  });
});
