import { describe, expect, it, beforeEach } from "vitest";
import type { CourseTree, SuggestedEntry } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TutorDatabase } from "../store/database.js";
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

  it("同一仓库+模块+说明 命中缓存，不重调 LLM，命中不带 usage", async () => {
    const { provider, calls } = fakeProvider([["n1", "n2"]]);
    const tree = treeWithNodes(["n1", "n2"]);
    const first = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "加载", provider, repositoryId: "repo" });
    expect(first.entries.map((entry: SuggestedEntry) => entry.id)).toEqual(["n1", "n2"]);
    expect(first.usage).toBeDefined();
    const second = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "加载", provider, repositoryId: "repo" });
    expect(second.entries).toEqual(first.entries);
    expect(second.usage).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("不同模块名或不同仓库各自调用；换模型未命中（键里有 modelVersion）", async () => {
    const { provider, calls } = fakeProvider([["n1"]]);
    const tree = treeWithNodes(["n1"]);
    await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo" });
    await suggestModuleEntriesCached({ tree, moduleLabel: "路由", moduleHint: "h", provider, repositoryId: "repo" });
    await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "other" });
    await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider: { ...provider, modelVersion: "stub-2" }, repositoryId: "repo" });
    expect(calls).toHaveLength(4);
  });

  it("键按本层实际输入：候选变了未命中，输入没变即使换 provider 实例也命中", async () => {
    const { provider, calls } = fakeProvider([["n1"]]);
    await suggestModuleEntriesCached({ tree: treeWithNodes(["n1"]), moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo" });
    // 课程树多出一个候选 → 送进模型的候选清单变了 → 必须重算，否则会复用「看不见新节点」的旧结果
    await suggestModuleEntriesCached({ tree: treeWithNodes(["n1", "n2"]), moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo" });
    expect(calls).toHaveLength(2);
    // 同一棵树换一个 provider 对象（同 name/modelVersion）：键只由实际输入构成，命中
    await suggestModuleEntriesCached({ tree: treeWithNodes(["n1", "n2"]), moduleLabel: "配置", moduleHint: "h", provider: { ...provider }, repositoryId: "repo" });
    expect(calls).toHaveLength(2);
  });

  it("空结果（LLM 失败回落）不缓存，下次仍会重试", async () => {
    const provider: LlmProvider = {
      name: "bad", modelVersion: "bad:model",
      async complete(): Promise<LlmCompletion> {
        return { text: "不是 JSON", finishReason: "stop" };
      }
    };
    const tree = treeWithNodes(["n1"]);
    const first = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo" });
    const second = await suggestModuleEntriesCached({ tree, moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo" });
    expect(first.entries).toEqual([]);
    expect(second.entries).toEqual([]);
  });

  it("持久层让重启不重烧：清空内存缓存后同键仍命中 SQLite；空列表不落盘", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "tutor-entry-persist-")));
    const database = new TutorDatabase(dir);
    try {
      const { provider, calls } = fakeProvider([["n1"]]);
      const input = { tree: treeWithNodes(["n1"]), moduleLabel: "配置", moduleHint: "h", provider, repositoryId: "repo", database };
      expect((await suggestModuleEntriesCached(input)).entries).toHaveLength(1);
      // 模拟 engine 重启：内存层被清空，SQLite 还在——同键直接命中，不再烧调用
      clearModuleEntryCache();
      const second = await suggestModuleEntriesCached(input);
      expect(second.entries.map((entry: SuggestedEntry) => entry.id)).toEqual(["n1"]);
      expect(second.usage).toBeUndefined();
      expect(calls).toHaveLength(1);

      // 空结果（可能是失败回落）在持久层同样不落盘：重启后重试而不是固化空列表
      const bad = fakeProvider([[]]);
      const emptyInput = { ...input, moduleLabel: "聊天", provider: bad.provider };
      expect((await suggestModuleEntriesCached(emptyInput)).entries).toHaveLength(0);
      clearModuleEntryCache();
      await suggestModuleEntriesCached(emptyInput);
      expect(bad.calls).toHaveLength(2);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
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
