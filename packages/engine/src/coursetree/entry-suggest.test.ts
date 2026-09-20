import { describe, expect, it, beforeEach } from "vitest";
import type { CourseTree, SuggestedEntry } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TutorDatabase } from "../store/database.js";
import { clearModuleEntryCache, rankEntryCandidates, suggestModuleEntriesCached } from "./entry-suggest.js";

/**
  场景感知的假 provider：`map.entry-expand`（主题翻译层）与 `map.entry-suggest`（选择层）分开记账。
  - `expandReply`：字符串数组 → 原样 JSON 输出；字符串 → 直接当响应文本（测坏输出）；
    "throw" → 抛错（测调用失败退化）。
  - `selectReplies`：按次返回的候选 id 列表；字符串项直接作为响应文本（"[]"=主动判空、坏 JSON=失败回落）。
  */
function fakeProvider(selectReplies: (string[] | string)[], expandReply: string[] | string | "throw" = ["zzz-unrelated"]): { provider: LlmProvider; selectCalls: LlmCompletionInput[]; expandCalls: LlmCompletionInput[] } {
  const selectCalls: LlmCompletionInput[] = [];
  const expandCalls: LlmCompletionInput[] = [];
  let selectIndex = 0;
  const provider: LlmProvider = {
    name: "fake-provider",
    modelVersion: "fake:model",
    async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
      if (input.scene === "map.entry-expand") {
        expandCalls.push(input);
        if (expandReply === "throw") throw new Error("expand boom");
        const text = typeof expandReply === "string" ? expandReply : JSON.stringify(expandReply);
        return { text, usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" };
      }
      selectCalls.push(input);
      const reply = selectReplies[Math.min(selectIndex, selectReplies.length - 1)];
      selectIndex += 1;
      const text = typeof reply === "string" ? reply : JSON.stringify(reply.map((id) => ({ id, reason: "入口实现" })));
      return { text, usage: { inputTokens: 100, outputTokens: 50 }, finishReason: "stop" };
    }
  };
  return { provider, selectCalls, expandCalls };
}

function treeWithNodes(ids: string[]): CourseTree {
  return {
    root: {
      id: "root", title: "root", kind: "overview", summary: "s",
      anchors: [], children: ids.map((id) => ({ id, title: id, kind: "module" as const, summary: "s", anchors: [{ path: `src/${id}.ts`, line: 1, label: "module" }], children: [] }))
    }
  } as unknown as CourseTree;
}

describe("suggestModuleEntriesCached", () => {
  beforeEach(() => clearModuleEntryCache());

  it("同一仓库+模块+说明 命中缓存，两段调用都不重跑，命中不带 usage", async () => {
    const { provider, selectCalls, expandCalls } = fakeProvider([["n1", "n2"]]);
    const tree = treeWithNodes(["n1", "n2"]);
    const first = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "加载", provider, repositoryId: "repo" });
    expect(first.entries.map((entry: SuggestedEntry) => entry.id)).toEqual(["n1", "n2"]);
    // 两段用量合并成一条记账（翻译 10/5 + 选择 100/50）
    expect(first.usage).toMatchObject({ inputTokens: 110, outputTokens: 55 });
    const second = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "加载", provider, repositoryId: "repo" });
    expect(second.entries).toEqual(first.entries);
    expect(second.usage).toBeUndefined();
    expect(selectCalls).toHaveLength(1);
    expect(expandCalls).toHaveLength(1);
  });

  it("不同模块名或不同仓库各自调用；换模型未命中（两层的键里都有 modelVersion）", async () => {
    const { provider, selectCalls, expandCalls } = fakeProvider([["n1"]]);
    const tree = treeWithNodes(["n1"]);
    await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo" });
    await suggestModuleEntriesCached({ tree, moduleLabel: "路由", moduleHint: "h", provider, repositoryId: "repo" });
    await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "other" });
    await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider: { ...provider, modelVersion: "stub-2" }, repositoryId: "repo" });
    expect(selectCalls).toHaveLength(4);
    expect(expandCalls).toHaveLength(4);
  });

  it("键按本层实际输入：候选变了未命中，输入没变即使换 provider 实例也命中", async () => {
    const { provider, selectCalls, expandCalls } = fakeProvider([["n1"]]);
    await suggestModuleEntriesCached({ tree: treeWithNodes(["n1"]), moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo" });
    // 课程树多出一个候选 → 送进模型的候选清单变了 → 必须重算，否则会复用「看不见新节点」的旧结果
    await suggestModuleEntriesCached({ tree: treeWithNodes(["n1", "n2"]), moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo" });
    expect(selectCalls).toHaveLength(2);
    // 同一棵树换一个 provider 对象（同 name/modelVersion）：键只由实际输入构成，命中
    await suggestModuleEntriesCached({ tree: treeWithNodes(["n1", "n2"]), moduleLabel: "配置", moduleHint: "h", provider: { ...provider }, repositoryId: "repo" });
    expect(selectCalls).toHaveLength(2);
    expect(expandCalls).toHaveLength(2);
  });

  it("选择层失败回落的空列表不缓存，下次仍会重试；翻译层失败退化为无扩展词且不缓存", async () => {
    const { provider, selectCalls, expandCalls } = fakeProvider(["不是 JSON"], "throw");
    const tree = treeWithNodes(["n1"]);
    const first = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo" });
    const second = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo" });
    expect(first.entries).toEqual([]);
    expect(first.declined).toBeFalsy();
    expect(second.entries).toEqual([]);
    expect(selectCalls).toHaveLength(2);
    expect(expandCalls).toHaveLength(2);
  });

  it("模型主动判空（declined）是可信答案：缓存复用，不逐次重试", async () => {
    const { provider, selectCalls } = fakeProvider(["[]"]);
    const tree = treeWithNodes(["n1"]);
    const first = await suggestModuleEntriesCached({ tree, moduleLabel: "玄学", moduleHint: "h", provider, repositoryId: "repo" });
    expect(first.entries).toEqual([]);
    expect(first.declined).toBe(true);
    const second = await suggestModuleEntriesCached({ tree, moduleLabel: "玄学", moduleHint: "h", provider, repositoryId: "repo" });
    expect(second.entries).toEqual([]);
    expect(second.declined).toBe(true);
    expect(selectCalls).toHaveLength(1);
  });

  it("持久层让重启不重烧：清空内存缓存后两层都命中 SQLite；失败回落在持久层同样不落盘", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-entry-persist-")));
    const database = new TutorDatabase(dir);
    try {
      const { provider, selectCalls, expandCalls } = fakeProvider([["n1"]]);
      const input = { tree: treeWithNodes(["n1"]), moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo", database };
      expect((await suggestModuleEntriesCached(input)).entries).toHaveLength(1);
      // 模拟 engine 重启：内存层被清空，SQLite 还在——同键直接命中，翻译层与选择层都不再烧调用
      clearModuleEntryCache();
      const second = await suggestModuleEntriesCached(input);
      expect(second.entries.map((entry: SuggestedEntry) => entry.id)).toEqual(["n1"]);
      expect(second.usage).toBeUndefined();
      expect(selectCalls).toHaveLength(1);
      expect(expandCalls).toHaveLength(1);

      // 失败回落（坏 JSON）在持久层不落盘：重启后重试而不是固化空列表
      const bad = fakeProvider(["坏输出"]);
      const emptyInput = { ...input, moduleLabel: "聊天", provider: bad.provider };
      expect((await suggestModuleEntriesCached(emptyInput)).entries).toHaveLength(0);
      clearModuleEntryCache();
      await suggestModuleEntriesCached(emptyInput);
      expect(bad.selectCalls).toHaveLength(2);

      // 主动判空在持久层落盘：重启后仍复用，不重复烧
      const declined = fakeProvider(["[]"]);
      const declinedInput = { ...input, moduleLabel: "并发", provider: declined.provider };
      expect((await suggestModuleEntriesCached(declinedInput)).declined).toBe(true);
      clearModuleEntryCache();
      const again = await suggestModuleEntriesCached(declinedInput);
      expect(again.declined).toBe(true);
      expect(declined.selectCalls).toHaveLength(1);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("主题翻译层的产出参与排序：中文主题零命中时靠英文扩展词命中，且输入含仓库路径词表", async () => {
    const { provider, expandCalls } = fakeProvider([["cache"]], ["cache"]);
    const tree = treeWithNodes(["cache", "blog"]);
    const result = await suggestModuleEntriesCached({ tree, moduleLabel: "操作系统", moduleHint: "进程内状态与并发", provider, repositoryId: "repo" });
    expect(result.entries.map((entry: SuggestedEntry) => entry.id)).toEqual(["cache"]);
    expect(expandCalls).toHaveLength(1);
    // 翻译层的输入：模块主题 + 仓库路径词指纹 + 明确的 JSON 数组出口
    expect(expandCalls[0].user).toContain("操作系统");
    expect(expandCalls[0].user).toContain("src");
  });
});

describe("rankEntryCandidates（词边界打分 + boost 补位 + 跨模块去重）", () => {
  const mk = (id: string, path: string, summary: string) => ({ id, title: id, path, line: 1, summary });

  it("锚点文件的 L1 摘要命中主题时排到最前（目录模板摘要无信号）", () => {
    const candidates = [mk("a", "README.md", "根目录含 1 个可分析文件"), mk("b", "utils/CacheClient.java", "含 2 个可分析文件")];
    const ranked = rankEntryCandidates(candidates, ["缓存"], new Map([["utils/CacheClient.java", "封装缓存读写相关操作。"]]));
    expect(ranked[0].id).toBe("b");
  });

  it("其他模块已推荐的路径被降权（跨模块去重）", () => {
    const candidates = [mk("a", "src/a.ts", "缓存工具类"), mk("b", "src/b.ts", "路由分发器")];
    const ranked = rankEntryCandidates(candidates, ["缓存"], new Map(), new Set(["src/a.ts"]));
    expect(ranked[0].id).toBe("b");
  });

  it("无命中候选保留在尾部，不丢（池子小时 LLM 仍可挑）", () => {
    const candidates = [mk("a", "src/x.ts", "s")];
    expect(rankEntryCandidates(candidates, ["完全不相关"], new Map())).toHaveLength(1);
  });

  it("短 ASCII 词元只认词边界：io 不再命中 Configuration，但仍命中 io 目录段与 HttpServletRequest", () => {
    const candidates = [
      mk("cfg", "src/config/ElasticsearchConfiguration.java", "Elasticsearch Configuration 初始化"),
      mk("nio", "src/main/java/io/net/Channel.java", "接收 HttpServletRequest 的通道"),
      mk("readme", "README.md", "说明文档")
    ];
    const ranked = rankEntryCandidates(candidates, ["io"], new Map([["README.md", "io 说明"]]));
    // cfg 路径/摘要都没有以 io 开头的整词 → 0 分垫底；nio 与 readme 命中
    expect(ranked[0].id).toBe("nio");
    expect(ranked[1].id).toBe("readme");
    expect(ranked[2].id).toBe("cfg");
    // http 命中摘要里的 HttpServletRequest（camel 切词后 http 是整词）
    const httpRanked = rankEntryCandidates(candidates, ["http"], new Map());
    expect(httpRanked[0].id).toBe("nio");
    expect(httpRanked[2].id).toBe("cfg");
  });

  it("非零候选不足时按 boostPaths 补零分候选，替代纯字典序（P3）", () => {
    const filler = Array.from({ length: 15 }, (_, index) => mk(`a${index}`, `src/dir/a${String(index).padStart(2, "0")}.ts`, "s"));
    const boosted = mk("b", "src/dir/b.ts", "s");
    const candidates = [...filler, boosted];
    // 无 boost：字典序前 15 个恰好都是 aXX，b.ts 被挤出
    expect(rankEntryCandidates(candidates, ["不相关主题"], new Map()).some((candidate) => candidate.id === "b")).toBe(false);
    // 有 boost：b.ts 顶到第一位，被挤掉的是字典序最后的 a14
    const ranked = rankEntryCandidates(candidates, ["不相关主题"], new Map(), new Set(), ["src/dir/b.ts"]);
    expect(ranked[0].id).toBe("b");
    expect(ranked.some((candidate) => candidate.id === "a14")).toBe(false);
  });

  it("零分候选每路径限 2 个：热点文件不独占整个池子；池子太小时放开设限不丢候选", () => {
    const hot = Array.from({ length: 15 }, (_, index) => mk(`h${index}`, "src/hot.ts", "s"));
    const filler = Array.from({ length: 30 }, (_, index) => mk(`m${index}`, `src/m${String(index).padStart(2, "0")}.ts`, "s"));
    const ranked = rankEntryCandidates([...hot, ...filler], ["不相关主题"], new Map(), new Set(), ["src/hot.ts"]);
    expect(ranked.filter((candidate) => candidate.path === "src/hot.ts")).toHaveLength(2);
    expect(ranked.map((candidate) => candidate.id).slice(0, 3)).toEqual(["h0", "h1", "m0"]);
    // 池子装不满 15 时放开设限：溢出候选仍参与（宁可见重复，不可见空位）
    const tiny = rankEntryCandidates(hot, ["不相关主题"], new Map(), new Set(), ["src/hot.ts"]);
    expect(tiny).toHaveLength(15);
  });

  it("被跨模块去重惩罚（负分）的候选不参与 boost 补位", () => {
    const candidates = [mk("a", "src/a.ts", "s"), mk("b", "src/b.ts", "路由分发器")];
    const ranked = rankEntryCandidates(candidates, ["缓存"], new Map(), new Set(["src/b.ts"]), ["src/b.ts"]);
    expect(ranked.map((candidate) => candidate.id)).toEqual(["a", "b"]);
  });
});
