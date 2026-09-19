import { describe, expect, it, beforeEach } from "vitest";
import type { CourseTree, SuggestedEntry } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { clearModuleEntryCache, rankEntryCandidates, suggestModuleEntriesCached } from "./entry-suggest.js";

function fakeProvider(replyIds: string[][]): { provider: LlmProvider; calls: LlmCompletionInput[] } {
  let call = 0;
  const calls: LlmCompletionInput[] = [];
  const provider: LlmProvider = {
    name: "fake-provider",
    modelVersion: "fake:model",
    async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
      calls.push(input);
      const ids = replyIds[Math.min(call, replyIds.length - 1)];
      call += 1;
      const payload = ids.map((id) => ({ id, reason: "入口实现" }));
      return { text: JSON.stringify(payload), usage: { inputTokens: 100, outputTokens: 50 }, finishReason: "stop" };
    }
  };
  return { provider, calls };
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

  it("同一 cacheKey+模块+说明 命中缓存，不重调 LLM，命中不带 usage", async () => {
    const { provider, calls } = fakeProvider([["n1", "n2"]]);
    const tree = treeWithNodes(["n1", "n2"]);
    const first = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "加载", provider, cacheKey: "repo:v1" });
    expect(first.entries.map((entry: SuggestedEntry) => entry.id)).toEqual(["n1", "n2"]);
    expect(first.usage).toBeDefined();
    const second = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "加载", provider, cacheKey: "repo:v1" });
    expect(second.entries).toEqual(first.entries);
    expect(second.usage).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("不同模块名或不同 cacheKey 各自调用；分析版本变化后缓存失效", async () => {
    const { provider, calls } = fakeProvider([["n1"]]);
    const tree = treeWithNodes(["n1"]);
    await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, cacheKey: "repo:v1" });
    await suggestModuleEntriesCached({ tree, moduleLabel: "路由", moduleHint: "h", provider, cacheKey: "repo:v1" });
    await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, cacheKey: "repo:v2" });
    expect(calls).toHaveLength(3);
  });

  it("空结果（LLM 失败回落）不缓存，下次仍会重试", async () => {
    const provider: LlmProvider = {
      name: "bad", modelVersion: "bad:model",
      async complete(): Promise<LlmCompletion> {
        return { text: "不是 JSON", finishReason: "stop" };
      }
    };
    const tree = treeWithNodes(["n1"]);
    const first = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, cacheKey: "repo:v1" });
    const second = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, cacheKey: "repo:v1" });
    expect(first.entries).toEqual([]);
    expect(second.entries).toEqual([]);
  });
});

describe("rankEntryCandidates（语义排序 + 跨模块去重）", () => {
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
});
