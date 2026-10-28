import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/domain";

import type { LlmCompletion, LlmCompletionInput, LlmMessage, LlmProvider } from "../application/port/llm-provider.js";
import { LlmAbortedError } from "../application/port/llm-provider.js";
import { buildSearchCorpus } from "./search-code.js";
import { TOOL_CONTEXT_KEEP_ROUNDS, compactTurnContext, completeWithOptionalSkills, completeWithReadTool, toolLoopAuditsOf, type ReadToolProgress, type TurnCheckpointChannel, type TurnLoopState } from "./tool-loop.js";

/** repoPath 指向本目录：内含稳定存在的真实文件。 */
const repoPath = import.meta.dirname;

function scriptedProvider(script: LlmCompletion[]): { provider: LlmProvider; calls: LlmCompletionInput[] } {
  const calls: LlmCompletionInput[] = [];
  let index = 0;
  return {
    calls,
    provider: {
      name: "scripted",
      modelVersion: "scripted:v1",
      async complete(input) {
        calls.push(input);
        return script[index++];
      }
    }
  };
}

const readCall = (id: string, path: string): LlmCompletion => ({ text: "", toolCalls: [{ id, name: "read_file", argumentsJson: JSON.stringify({ path }) }], usage: { inputTokens: 100, outputTokens: 10 }, finishReason: "tool_calls" });

describe("completeWithReadTool", () => {
  it("轮数预算用尽时明确回绝未应答的 tool_call，再做一轮不带工具的收尾", async () => {
    const { provider, calls } = scriptedProvider([
      readCall("c1", "read-file.ts"),
      readCall("c2", "read-file.ts"),
      { text: "基于已有上下文回答。", usage: { inputTokens: 50, outputTokens: 20 }, finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "问题原文", maxTokens: 700, temperature: 0, maxRounds: 1, maxCalls: 5 });
    expect(result.completion.text).toContain("基于已有上下文回答");
    expect(result.stoppedBy, "到的是轮数闸，读数就不能与预算或读文件额度混成一档").toBe("rounds");
    expect(result.fileReads.map((read) => read.path)).toEqual(["read-file.ts"]);
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 40 });
    // 收尾轮不再带工具。
    expect(calls[2].tools).toBeUndefined();
    const refusal = calls[2].messages?.find((message) => message.role === "tool" && message.content.includes("工具轮次已用完"));
    expect(refusal?.content, "到限的是轮数，回话就不能说成读文件上限——模型会把这句转述给学习者").toContain("读文件额度还剩 4 次");
    // 收尾这一次是最后一次调用：读到的正文必须原样在场。
    const readBody = calls[2].messages?.find((message) => message.role === "tool" && message.content.startsWith("文件 "));
    expect(readBody?.content, "到闸收尾把正文抽成占位符，这一回合就交不出东西").not.toContain("已折叠");
    // 首轮 user 消息始终在 messages[0]。
    expect(calls[1].messages?.[0]).toMatchObject({ role: "user" });
    expect(calls[1].messages?.[0].content).toBe("问题原文");
  });

  it("累计文件数用尽时同样收尾；未知工具回喂明确提示", async () => {
    const { provider, calls } = scriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "read-file.ts" }) }, { id: "c2", name: "write_file", argumentsJson: "{}" }], finishReason: "tool_calls" },
      readCall("c3", "read-file.ts"),
      { text: "收尾。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 5, maxCalls: 1 });
    expect(result.completion.text).toBe("收尾。");
    const unknown = calls[2].messages?.find((message) => message.role === "tool" && message.content.includes("未知工具"));
    expect(unknown?.content).toContain("只支持 read_file");
    expect(result.fileReads).toHaveLength(1); // 未知工具不计入读取审计
  });

  it("额度在同一轮里花完也逐条挡：轮首那次判据只挡得到下一轮", async () => {
    const { provider, calls } = scriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "read-file.ts" }) }, { id: "c2", name: "read_file", argumentsJson: JSON.stringify({ path: "tool-loop.ts" }) }], finishReason: "tool_calls" },
      { text: "看完了。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 3, maxCalls: 1 });
    // 两条都发在同一个回合里：只读到 1 个。
    expect(result.fileReads).toHaveLength(1);
    const blocked = calls[1].messages?.find((message) => message.role === "tool" && message.content.includes("读文件上限"));
    expect(blocked?.content, "第二条读取要照实回绝，不能悄悄真读").toBeDefined();
    expect(result.completion.text).toBe("看完了。");
  });

  it("被护栏拒绝的读取计入审计（denied），不中断对话", async () => {
    const { provider } = scriptedProvider([
      readCall("c1", ".env"),
      { text: "改看别的文件。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 3 });
    expect(result.fileReads).toHaveLength(1);
    expect(result.fileReads[0]).toMatchObject({ path: ".env", denied: true });
    expect(result.completion.text).toContain("改看别的文件");
  });

  it("被拒绝的读取不占文件额度：额度 1 也能在被拒后继续读真文件", async () => {
    const { provider, calls } = scriptedProvider([
      readCall("c1", ".env"),
      readCall("c2", "read-file.ts"),
      { text: "看完了。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 3, maxCalls: 1 });
    expect(result.completion.text).toBe("看完了。");
    // 两次都进审计，只有成功那次占额度。
    expect(result.fileReads.map((read) => read.denied)).toEqual([true, false]);
    expect(calls[2].tools).toBeDefined();
    const readBack = calls[2].messages?.find((message) => message.role === "tool" && message.content.startsWith("文件 "));
    expect(readBack?.content).toContain("read-file.ts");
  });
});

describe("completeWithReadTool 的用量汇总", () => {
  it("跨轮相加带上前缀缓存命中字段（教学线 journal 的 cache_hit 口径靠它）", async () => {
    const { provider } = scriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "read-file.ts" }) }], usage: { inputTokens: 8_000, outputTokens: 10, promptCacheHitTokens: 7_000 }, finishReason: "tool_calls" },
      { text: "读完的回答。", usage: { inputTokens: 9_000, outputTokens: 20, promptCacheHitTokens: 8_000 }, finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 5 });
    // 两边都没上报 cache_hit 时该字段整个缺席，而不是 0。
    expect(result.usage).toEqual({ inputTokens: 17_000, outputTokens: 30, promptCacheHitTokens: 15_000 });
  });
});

describe("completeWithReadTool 的中止", () => {
  it("signal 透传到每一轮调用", async () => {
    const controller = new AbortController();
    const { provider, calls } = scriptedProvider([readCall("c1", "read-file.ts"), { text: "答完。", finishReason: "stop" }]);
    await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 3, maxCalls: 5, signal: controller.signal });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  it("轮次之间被中止 → 抛 LlmAbortedError，不再开新一轮（也不落收尾调用）", async () => {
    const controller = new AbortController();
    const { provider, calls } = scriptedProvider([readCall("c1", "read-file.ts"), { text: "不该出现。", finishReason: "stop" }]);
    const pending = completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 3, maxCalls: 5, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(LlmAbortedError);
    expect(calls).toHaveLength(1);
  });

  it("预算打满的收尾轮同样被中止拦下：错误上抛而不是伪装成答完", async () => {
    const controller = new AbortController();
    const { provider, calls } = scriptedProvider([readCall("c1", "read-file.ts"), { text: "不该出现。", finishReason: "stop" }]);
    controller.abort();
    await expect(completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 1, maxCalls: 1, signal: controller.signal }))
      .rejects.toBeInstanceOf(LlmAbortedError);
    expect(calls).toHaveLength(1);
  });

  /** 回合作废时，本轮已发生的工具调用要随异常带出去。 */
  it("最后一趟 LLM 在途被中止：异常上带着本轮已发生的读文件、技能与外部调用", async () => {
    const externalTool = { name: "mcp__docs__lookup", description: "【外部 docs】查一份文档", parameters: { type: "object" as const, properties: {} } };
    const audit = { server: "docs", tool: "lookup", argsChars: 2, argsHash: "000000000000", resultChars: 6, masked: 0, ok: true, ms: 1 };
    let n = 0;
    const provider: LlmProvider = {
      name: "scripted",
      modelVersion: "scripted:v1",
      complete: async () => {
        n += 1;
        if (n === 1) {
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              { id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "read-file.ts" }) },
              { id: "s1", name: "read_skill", argumentsJson: JSON.stringify({ name: "tutor-cost-audit" }) },
              { id: "e1", name: "mcp__docs__lookup", argumentsJson: "{}" }
            ]
          };
        }
        throw new LlmAbortedError();
      }
    };
    const error = await completeWithReadTool({
      provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 5, maxCalls: 5,
      skills: { brief: "可用技能：\n- tutor-cost-audit：对账", bodyOf: (name) => (name === "tutor-cost-audit" ? "第一步：看 llm.log。" : undefined) },
      external: { tools: [externalTool], call: async () => ({ text: "外部正文。", audit }) }
    }).then(() => undefined, (caught: unknown) => caught);
    expect(error, "中止没上抛").toBeInstanceOf(LlmAbortedError);
    expect(toolLoopAuditsOf(error)).toMatchObject({
      rounds: 1,
      fileReads: [expect.objectContaining({ path: "read-file.ts", denied: false })],
      codeSearches: [],
      skillReads: [{ skill: "tutor-cost-audit", chars: "第一步：看 llm.log。".length, found: true }],
      mcpCalls: [audit]
    });
    // 走 symbol 键：错误形状与一条裸的中止错误同形。
    expect(Object.keys(error as object)).toEqual(Object.keys(new LlmAbortedError()));
    expect(JSON.stringify(error)).not.toContain("read-file.ts");
  });

  it("轮次之间被中止：本轮已经读过的照样带上（空数组只允许真的什么都没做）", async () => {
    const controller = new AbortController();
    let n = 0;
    const provider: LlmProvider = {
      name: "scripted",
      modelVersion: "scripted:v1",
      complete: async () => {
        n += 1;
        // 第一趟读一个、被拒一个；第二趟时用户已点停止。
        if (n === 1) {
          return { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "read-file.ts" }) }, { id: "c2", name: "read_file", argumentsJson: JSON.stringify({ path: ".env" }) }] };
        }
        controller.abort();
        return { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c3", name: "read_file", argumentsJson: JSON.stringify({ path: "tool-loop.ts" }) }] };
      }
    };
    const error = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 5, maxCalls: 5, signal: controller.signal })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmAbortedError);
    expect(n, "中止后不该把第二趟的工具调用真执行掉").toBe(2);
    // 被拒读的那次也要留痕。
    expect(toolLoopAuditsOf(error)?.fileReads.map((read) => `${read.path}:${read.denied ? "拒" : "读"}`)).toEqual(["read-file.ts:读", ".env:拒"]);
  });
});

describe("completeWithReadTool 的 search_code 集成", () => {
  const corpus = buildSearchCorpus(
    { files: [{ path: "read-file.ts", extension: ".ts", bytes: 1, lines: 100 }] } as unknown as RepositoryIndex,
    { graph: { imports: { "read-file.ts": [] }, symbols: [{ id: "s1", name: "executeReadFile", kind: "function", path: "read-file.ts", line: 5 }] } } as unknown as RepositoryAnalysis,
    new Map([["read-file.ts", "读取仓库内文件的行窗口"]])
  );
  const searchCall = (id: string, query: string): LlmCompletion => ({ text: "", toolCalls: [{ id, name: "search_code", argumentsJson: JSON.stringify({ query }) }], finishReason: "tool_calls" });

  it("传入语料时开放两个工具；检索结果回喂、不占文件额度、不记 file_read", async () => {
    const { provider, calls } = scriptedProvider([
      searchCall("c1", "read"),
      readCall("c2", "read-file.ts"),
      { text: "先搜后读的回答。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 3, maxCalls: 1, search: corpus });
    expect(calls[0].tools?.map((tool) => tool.name)).toEqual(["read_file", "search_code"]);
    const searchResult = calls[1].messages?.find((message) => message.role === "tool");
    expect(searchResult?.content).toContain('search_code "read"');
    expect(searchResult?.content).toContain("read-file.ts");
    // maxCalls=1 只被那次成功的 read 用掉。
    expect(result.codeSearches).toEqual([{ query: "read", hits: 1, topPaths: ["read-file.ts"] }]);
    expect(result.fileReads).toHaveLength(1);
    expect(result.completion.text).toBe("先搜后读的回答。");
  });

  it("未传语料时 search_code 是未知工具（工具清单与提示都只认 read_file）", async () => {
    const { provider, calls } = scriptedProvider([
      searchCall("c1", "read"),
      { text: "收尾。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 3 });
    expect(calls[0].tools?.map((tool) => tool.name)).toEqual(["read_file"]);
    const unknown = calls[1].messages?.find((message) => message.role === "tool");
    expect(unknown?.content).toContain("未知工具 search_code");
    expect(unknown?.content).toContain("只支持 read_file。");
    expect(result.codeSearches).toEqual([]);
  });
});

/** 跨仓那一档：换根时守卫照用、未知仓名照实回、没有第二个仓时工具清单不变。 */
describe("completeWithReadTool 的跨仓访问", () => {
  const other = mkdtempSync(join(tmpdir(), "tutor-cross-"));
  writeFileSync(join(other, "ShopController.java"), "class ShopController {\n  save() {}\n}\n", "utf8");
  writeFileSync(join(other, ".env"), "SECRET=leak\n", "utf8");
  afterAll(() => { rmSync(other, { recursive: true, force: true }); });
  const cross = { roots: { other }, links: (name: string) => `仓 ${name} 的接缝：/api/shop/save → ShopController.java:2` };
  const crossRead = (id: string, path: string, repo: string): LlmCompletion => ({ text: "", toolCalls: [{ id, name: "read_file", argumentsJson: JSON.stringify({ path, repo }) }], finishReason: "tool_calls" });

  it("带 repo 就读对端仓，审计与正文都带上仓名", async () => {
    const { provider, calls } = scriptedProvider([crossRead("c1", "ShopController.java", "other"), { text: "对端在 ShopController。", finishReason: "stop" }]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 5, cross });
    expect(result.fileReads.map((read) => read.path)).toEqual(["other/ShopController.java"]);
    const toolMessage = calls[1].messages?.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("【来自仓 other】");
    expect(toolMessage?.content).toContain("save()");
  });

  it("守卫跟着目标根走：对端仓的 .env 照样拒读", async () => {
    const { provider } = scriptedProvider([crossRead("c1", ".env", "other"), { text: "收尾。", finishReason: "stop" }]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 5, cross });
    expect(result.fileReads[0].denied).toBe(true);
    expect(result.fileReads[0].path).toBe("other/.env");
  });

  it("`__proto__` 这类原型属性名不算仓库：回喂未知仓库清单，不抛异常终止回合", async () => {
    const { provider, calls } = scriptedProvider([crossRead("c1", "ShopController.java", "__proto__"), { text: "收尾。", finishReason: "stop" }]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 5, cross });
    const tool = calls[1].messages?.find((message) => message.role === "tool");
    expect(tool?.content).toContain("未知仓库「__proto__」");
    expect(result.fileReads).toHaveLength(0);
  });

  it("未知仓名回喂可用清单且不占额度；跨仓读另有独立上限", async () => {
    const { provider, calls } = scriptedProvider([
      crossRead("c1", "ShopController.java", "nope"),
      { text: "", toolCalls: [{ id: "c2", name: "read_file", argumentsJson: JSON.stringify({ path: "ShopController.java", repo: "other" }) }, { id: "c3", name: "read_file", argumentsJson: JSON.stringify({ path: "ShopController.java", repo: "other" }) }], finishReason: "tool_calls" },
      { text: "收尾。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 3, maxCalls: 5, cross: { ...cross, maxCrossReads: 1 } });
    const unknown = calls[1].messages?.find((message) => message.role === "tool");
    expect(unknown?.content).toContain("未知仓库「nope」");
    expect(unknown?.content).toContain("other");
    // 跨仓额度只够一条真实读取。
    expect(result.fileReads.filter((read) => !read.denied)).toHaveLength(1);
    const capped = calls[2].messages?.filter((message) => message.role === "tool");
    expect(capped?.some((message) => message.content.includes("跨仓读取最多 1 个文件"))).toBe(true);
  });

  it("跨仓读成功才回报递出去的路径（供复检留痕）；本仓读与拒读都不回报", async () => {
    const handed: string[] = [];
    const { provider } = scriptedProvider([
      crossRead("c1", "ShopController.java", "other"),
      crossRead("c2", ".env", "other"),
      readCall("c3", "read-file.ts"),
      { text: "收尾。", finishReason: "stop" }
    ]);
    await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 4, maxCalls: 5, cross: { ...cross, onHandedOut: (repo, path) => handed.push(`${repo}/${path}`) } });
    // 只有真读到的对端文件进这份登记。
    expect(handed).toEqual(["other/ShopController.java"]);
  });

  it("cross_repo_link 回清单文本；没给 links 就不开放这个工具", async () => {
    const { provider, calls } = scriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "cross_repo_link", argumentsJson: JSON.stringify({ repo: "other" }) }], finishReason: "tool_calls" },
      { text: "落点在 ShopController.java:2。", finishReason: "stop" }
    ]);
    await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 5, cross });
    expect(calls[0].tools?.map((tool) => tool.name)).toEqual(["read_file", "cross_repo_link"]);
    expect(calls[1].messages?.find((message) => message.role === "tool")?.content).toContain("/api/shop/save");
    const without = scriptedProvider([{ text: "收尾。", finishReason: "stop" }]);
    await completeWithReadTool({ provider: without.provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 5 });
    expect(without.calls[0].tools?.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(JSON.stringify(without.calls[0].tools)).not.toContain("repo");
  });

  it("有跨仓时 read_file 的 schema 里带上可用仓名", async () => {
    const { provider, calls } = scriptedProvider([{ text: "收尾。", finishReason: "stop" }]);
    await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 5, cross });
    expect(JSON.stringify(calls[0].tools)).toContain("可用值：other");
  });
});

describe("外部能力面（技能与 MCP），默认关闭", () => {
  const externalTool = { name: "mcp__docs__lookup", description: "【外部 docs】查一份文档", parameters: { type: "object" as const, properties: {} } };

  it("什么都不传时工具清单逐字不变（默认关闭不是靠开关，是靠不加）", async () => {
    const { provider, calls } = scriptedProvider([{ text: "答。", finishReason: "stop" }]);
    await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 2, maxCalls: 2 });
    expect(calls[0].tools?.map((tool) => tool.name)).toEqual(["read_file"]);
  });

  it("给了技能才有 read_skill；正文按名字取，取不到的也记进审计", async () => {
    const { provider, calls } = scriptedProvider([
      { text: "", toolCalls: [{ id: "s1", name: "read_skill", argumentsJson: JSON.stringify({ name: "tutor-cost-audit" }) }, { id: "s2", name: "read_skill", argumentsJson: JSON.stringify({ name: "不存在的技能" }) }], finishReason: "tool_calls" },
      { text: "照做法答。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({
      provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 2, maxCalls: 2,
      skills: { brief: "可用技能：\n- tutor-cost-audit：对账", bodyOf: (name) => (name === "tutor-cost-audit" ? "第一步：看 llm.log。" : undefined) }
    });
    expect(calls[0].tools?.map((tool) => tool.name)).toEqual(["read_file", "read_skill"]);
    const messages = calls[1].messages ?? [];
    expect(messages.find((message) => message.toolCallId === "s1")?.content).toContain("看 llm.log");
    expect(messages.find((message) => message.toolCallId === "s2")?.content).toContain("没有「不存在的技能」这份技能");
    // 正文为空与没装是两件事：found 仍为 true。
    const blank = await completeWithReadTool({
      provider: scriptedProvider([{ text: "", toolCalls: [{ id: "b1", name: "read_skill", argumentsJson: JSON.stringify({ name: "empty-skill" }) }], finishReason: "tool_calls" }, { text: "答。", finishReason: "stop" }]).provider,
      repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 2, maxCalls: 2,
      skills: { brief: "可用技能：\n- empty-skill：一份还没写正文的技能。", bodyOf: (name) => (name === "empty-skill" ? "" : undefined) }
    });
    expect(blank.skillReads).toEqual([{ skill: "empty-skill", chars: 0, found: true }]);
    // found:false 必须照样记。
    expect(result.skillReads).toEqual([
      { skill: "tutor-cost-audit", chars: "第一步：看 llm.log。".length, found: true },
      { skill: "不存在的技能", chars: 0, found: false }
    ]);
  });

  it("外部调用并进清单、结果回喂，且不吃读文件额度（读文件额度只管本地读取）", async () => {
    const audit = { server: "docs", tool: "lookup", argsChars: 2, argsHash: "000000000000", resultChars: 6, masked: 0, ok: true, ms: 3 };
    const { provider, calls } = scriptedProvider([
      { text: "", toolCalls: [{ id: "e1", name: "mcp__docs__lookup", argumentsJson: "{}" }], finishReason: "tool_calls" },
      { text: "", toolCalls: [{ id: "r1", name: "read_file", argumentsJson: JSON.stringify({ path: "read-file.ts" }) }], finishReason: "tool_calls" },
      { text: "答。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({
      provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 5, maxCalls: 1,
      external: { tools: [externalTool], call: async () => ({ text: "外部正文。", audit }) }
    });
    expect(calls[0].tools?.map((tool) => tool.name)).toEqual(["read_file", "mcp__docs__lookup"]);
    expect((calls[1].messages ?? []).find((message) => message.toolCallId === "e1")?.content).toBe("外部正文。");
    expect(result.fileReads.map((read) => read.path)).toEqual(["read-file.ts"]);
    expect(result.mcpCalls).toEqual([audit]);
  });

  it("每一类工具活动都各自上一帧：技能、改图、查产物、外部调用都不该是静默的", async () => {
    const audit = { server: "docs", tool: "lookup", argsChars: 2, argsHash: "000000000000", resultChars: 4, masked: 0, ok: true, ms: 1 };
    const { provider } = scriptedProvider([
      { text: "", toolCalls: [{ id: "k1", name: "read_skill", argumentsJson: JSON.stringify({ name: "demo" }) }], finishReason: "tool_calls" },
      { text: "", toolCalls: [{ id: "d1", name: "set_diagram", argumentsJson: "{}" }], finishReason: "tool_calls" },
      { text: "", toolCalls: [{ id: "f1", name: "query_facts", argumentsJson: "{}" }], finishReason: "tool_calls" },
      { text: "", toolCalls: [{ id: "e1", name: "mcp__docs__lookup", argumentsJson: "{}" }], finishReason: "tool_calls" },
      { text: "答完。", finishReason: "stop" }
    ]);
    const frames: ReadToolProgress[] = [];
    await completeWithReadTool({
      provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 6, maxCalls: 5,
      skills: { brief: "可用技能：demo", bodyOf: () => "做法。" },
      diagram: { apply: () => "已落成一张图。" },
      facts: { apply: () => "在册：分层。" },
      external: { tools: [externalTool], call: async () => ({ text: "外部正文", audit }) },
      onProgress: (frame) => frames.push(frame)
    });
    // 一轮一件活动：帧序是「想 → 做 → 想 → 做」。
    expect(frames).toEqual([
      { type: "thinking" }, { type: "loading_skill", skill: "demo" },
      { type: "thinking" }, { type: "editing_diagram" },
      { type: "thinking" }, { type: "querying_facts" },
      { type: "thinking" }, { type: "calling_external" },
      { type: "thinking" }
    ]);
  });

  it("外部调用另有每回合上限：用尽后不再打外部程序，回话照实说（免得模型以为工具坏了反复重试）", async () => {
    let fired = 0;
    const { provider, calls } = scriptedProvider([
      { text: "", toolCalls: [{ id: "e1", name: "mcp__docs__lookup", argumentsJson: "{}" }], finishReason: "tool_calls" },
      { text: "", toolCalls: [{ id: "e2", name: "mcp__docs__lookup", argumentsJson: "{}" }], finishReason: "tool_calls" },
      { text: "答。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({
      provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 5, maxCalls: 5,
      external: { tools: [externalTool], maxCalls: 1, call: async () => { fired += 1; return { text: "外部正文。", audit: { server: "docs", tool: "lookup", argsChars: 2, argsHash: "0", resultChars: 6, masked: 0, ok: true, ms: 1 } }; } }
    });
    expect((calls[2].messages ?? []).find((message) => message.toolCallId === "e2")?.content).toContain("最多打 1 次");
    expect(fired).toBe(1);
    expect(result.mcpCalls).toHaveLength(1);
  });

  it("外部工具报错也不掀掉回合：回话照实进消息，审计留下 error", async () => {
    const { provider, calls } = scriptedProvider([
      { text: "", toolCalls: [{ id: "e1", name: "mcp__docs__lookup", argumentsJson: "{}" }], finishReason: "tool_calls" },
      { text: "带保留答。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({
      provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 3, maxCalls: 2,
      external: { tools: [externalTool], call: async () => ({ text: "外部工具没连上。", audit: { server: "docs", tool: "lookup", argsChars: 2, argsHash: "0", resultChars: 8, masked: 0, ok: false, ms: 1, error: "timeout" } }) }
    });
    expect((calls[1].messages ?? []).find((message) => message.toolCallId === "e1")?.content).toContain("没连上");
    expect(result.completion.text).toBe("带保留答。");
    expect(result.mcpCalls[0].ok).toBe(false);
  });
});

/** 回合内压缩：既不能逐轮重付同一份正文，也不能让模型以为自己没读过。 */
describe("compactTurnContext", () => {
  /** 一条真实的读取结果形状：抬头写明文件与行区间。 */
  const readBody = (path: string) => `文件 ${path}（第 1-200 行，共 400 行，已达单次读取预算，继续读请用 offset=201）：\n${"1| const value = 1;\n".repeat(200)}`;
  const roundOf = (index: number): LlmMessage[] => [
    { role: "assistant", content: "", reasoningContent: `推理${index}`, toolCalls: [{ id: `c${index}`, name: "read_file", argumentsJson: JSON.stringify({ path: `f${index}.ts` }) }] },
    { role: "tool", toolCallId: `c${index}`, content: readBody(`f${index}.ts`) }
  ];
  const roundsOf = (count: number): LlmMessage[] => Array.from({ length: count }, (_, index) => roundOf(index + 1)).flat();
  const tools = (messages: LlmMessage[]) => messages.filter((message) => message.role === "tool");
  const assistants = (messages: LlmMessage[]) => messages.filter((message) => message.role === "assistant");

  it("工具结果只完整保留最近几轮，更早的折叠掉正文、留下「哪个文件第几到第几行」", () => {
    const messages = roundsOf(TOOL_CONTEXT_KEEP_ROUNDS + 2);
    compactTurnContext(messages);
    const results = tools(messages);
    const folded = results.slice(0, 2);
    const intact = results.slice(2);
    for (const message of folded) {
      expect(message.content.length, "折叠后还留着整份正文等于没折").toBeLessThan(400);
      expect(message.content).toContain("已折叠");
      expect(message.content, "抬头在：模型据此知道自己读过哪一段，不会重复读也不会说成读取失败").toContain("文件 f");
      expect(message.content).toContain("第 1-200 行");
      expect(message.content).toContain("offset=201");
    }
    for (const message of intact) expect(message.content).toContain("const value = 1;");
  });

  it("reasoning 一律丢，只有最近一次工具调用那条留着（协议要求原样回传）", () => {
    const messages = roundsOf(TOOL_CONTEXT_KEEP_ROUNDS + 2);
    compactTurnContext(messages);
    const kept = assistants(messages);
    expect(kept.slice(0, -1).every((message) => message.reasoningContent === undefined), "推理 token 是账单大头，且下一轮用不上").toBe(true);
    expect(kept.at(-1)?.reasoningContent).toBe(`推理${TOOL_CONTEXT_KEEP_ROUNDS + 2}`);
    // tool_calls 骨架不能跟着折叠摘掉。
    expect(kept.every((message) => message.toolCalls?.length === 1)).toBe(true);
  });

  it("到闸收尾（keepToolResults）：正文全留着，reasoning 照丢", () => {
    const messages = roundsOf(TOOL_CONTEXT_KEEP_ROUNDS + 2);
    compactTurnContext(messages, { keepToolResults: true });
    expect(tools(messages).every((message) => message.content.includes("const value = 1;"))).toBe(true);
    expect(assistants(messages).slice(0, -1).every((message) => message.reasoningContent === undefined)).toBe(true);
  });

  it("轮数还没超过保留窗口时正文一字不动，reasoning 照丢", () => {
    const messages = roundsOf(TOOL_CONTEXT_KEEP_ROUNDS);
    const bodies = tools(messages).map((message) => message.content);
    compactTurnContext(messages);
    expect(tools(messages).map((message) => message.content)).toEqual(bodies);
    expect(assistants(messages).map((message) => message.reasoningContent)).toEqual([undefined, `推理${TOOL_CONTEXT_KEEP_ROUNDS}`]);
  });

  it("跨仓结果的抬头是两行：折叠后仓名与文件行区间都还在", () => {
    const oldest: LlmMessage[] = [
      { role: "assistant", content: "", reasoningContent: "推理0", toolCalls: [{ id: "cX", name: "read_file", argumentsJson: JSON.stringify({ path: "Shop.java", repo: "other" }) }] },
      { role: "tool", toolCallId: "cX", content: `【来自仓 other】\n${readBody("Shop.java")}` }
    ];
    const messages = [...oldest, ...roundsOf(TOOL_CONTEXT_KEEP_ROUNDS)];
    compactTurnContext(messages);
    const folded = tools(messages)[0];
    expect(folded.content).toContain("已折叠");
    expect(folded.content).toContain("【来自仓 other】");
    expect(folded.content).toContain("文件 Shop.java");
  });
});

/** 回合检查点与每轮调用前的预算复查：收尾要清、用户停止要清、到线不许继续加轮。 */
describe("回合检查点与预算闸门", () => {
  const emptyState = (rounds: number): TurnLoopState => ({
    messages: [
      { role: "user", content: "首问原文" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: JSON.stringify({ path: "read-file.ts" }) }] },
      { role: "tool", toolCallId: "c1", content: "文件 read-file.ts（第 1-3 行）：\n1| import { readFileSync } from \"node:fs\";" }
    ],
    rounds,
    succeededReads: 1,
    crossReads: 0,
    externalCalls: 0,
    fileReads: [{ path: "read-file.ts", lines: 3, truncated: false, denied: false }],
    codeSearches: [],
    skillReads: [],
    mcpCalls: []
  });

  /** 记账用的假通道。 */
  function fakeChannel(restored?: { round: number; state: TurnLoopState }) {
    const saved: { round: number; stoppedReason?: string }[] = [];
    let cleared = 0;
    return {
      saved: () => saved,
      cleared: () => cleared,
      channel: {
        restore: () => restored,
        save: (_hash: string, state: TurnLoopState, stoppedReason?: string) => { saved.push({ round: state.rounds, ...(stoppedReason ? { stoppedReason } : {}) }); },
        clear: () => { cleared += 1; }
      } satisfies TurnCheckpointChannel
    };
  }

  it("每完成一轮存一份快照，答完就清空", async () => {
    const tracker = fakeChannel();
    const { provider, calls } = scriptedProvider([readCall("c1", "read-file.ts"), { text: "答完。", finishReason: "stop" }]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 3, maxCalls: 5, checkpoint: tracker.channel });
    expect(tracker.saved()).toEqual([{ round: 1 }]);
    expect(tracker.cleared(), "答完了还留着残局，下一次就会误续一个已经结束的回合").toBe(1);
    expect(result.resumedFromRound).toBeUndefined();
    expect(calls[1].messages).toBeDefined();
  });

  it("有残局就从那一轮接着开火：不重放首轮，已读到的正文直接在场", async () => {
    const tracker = fakeChannel({ round: 1, state: emptyState(1) });
    const { provider, calls } = scriptedProvider([{ text: "接上了。", finishReason: "stop" }]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "换了一份新的首问原文", maxTokens: 100, temperature: 0, maxRounds: 3, maxCalls: 5, checkpoint: tracker.channel });
    expect(calls).toHaveLength(1);
    expect(calls[0].user, "续跑不带 user：首轮已经在 messages[0] 里，再给一份会重复付一遍上下文").toBeUndefined();
    expect(calls[0].messages?.[0].content).toBe("首问原文");
    expect(calls[0].tools, "续跑之后还要能继续用工具").toBeDefined();
    expect(result.resumedFromRound).toBe(1);
    expect(result.fileReads.map((read) => read.path)).toEqual(["read-file.ts"]);
    expect(tracker.cleared()).toBe(1);
  });

  it("残局里的读文件额度跟着状态回来：续跑不会把已经用掉的额度重新花一遍", async () => {
    const tracker = fakeChannel({ round: 1, state: emptyState(1) });
    const { provider, calls } = scriptedProvider([readCall("c2", "tool-loop.ts"), { text: "答完。", finishReason: "stop" }]);
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 5, maxCalls: 2, checkpoint: tracker.channel });
    // 额度 2：残局已用掉 1 次，这一轮用掉第 2 次后收尾。
    expect(result.fileReads.map((read) => read.path)).toEqual(["read-file.ts", "tool-loop.ts"]);
    expect(result.rounds).toBe(2);
    // 两趟调用：续跑的一轮与答完的一趟，首轮不重放。
    expect(calls).toHaveLength(2);
  });

  it("异常退出留下 stopped_reason=error 的残局，不清空", async () => {
    const tracker = fakeChannel();
    let fired = 0;
    const provider: LlmProvider = {
      name: "scripted",
      modelVersion: "scripted:v1",
      complete: async () => {
        fired += 1;
        if (fired === 1) return readCall("c1", "read-file.ts");
        throw new Error("端点 500");
      }
    };
    await expect(completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 3, maxCalls: 5, checkpoint: tracker.channel })).rejects.toThrow("端点 500");
    expect(tracker.saved()).toEqual([{ round: 1 }, { round: 1, stoppedReason: "error" }]);
    expect(tracker.cleared(), "残局就是给人续的，清了等于白死一次").toBe(0);
  });

  it("用户主动停止不留残局：那一轮按作废收尾", async () => {
    const tracker = fakeChannel();
    const controller = new AbortController();
    controller.abort();
    const { provider } = scriptedProvider([readCall("c1", "read-file.ts"), { text: "不该出现。", finishReason: "stop" }]);
    await expect(completeWithReadTool({ provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 1, maxCalls: 1, signal: controller.signal, checkpoint: tracker.channel }))
      .rejects.toBeInstanceOf(LlmAbortedError);
    expect(tracker.saved(), "中止不留残局：替他续跑是违背他的意图").toEqual([]);
    expect(tracker.cleared()).toBe(1);
  });

  it("每轮开火前查预算：到线就不再执行工具，收尾那句说的是预算不是读文件上限", async () => {
    let asked = 0;
    const { provider, calls } = scriptedProvider([readCall("c1", "read-file.ts"), { text: "收尾。", finishReason: "stop" }]);
    const result = await completeWithReadTool({
      provider, repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 5, maxCalls: 5,
      budgetGuard: () => { asked += 1; return asked === 1 ? "本仓本月预算（5）已经用完，这是本次对话的最后一趟调用。" : undefined; }
    });
    expect(result.fileReads, "到线那一轮不该再把工具调用执行掉").toEqual([]);
    expect(result.stoppedBy).toBe("budget");
    const refusal = (calls[1].messages ?? []).find((message) => message.role === "tool");
    expect(refusal?.content).toContain("本仓本月预算");
    expect(refusal?.content, "错话说成「读文件上限」会被模型原样转述给学习者").not.toContain("读文件上限");
    expect(calls[1].tools, "收尾轮不带工具").toBeUndefined();
  });
});

describe("到限中断（宏观设计那一档：不出成品，留快照等重试）", () => {
  /** 每趟都带一个工具调用：要能撑到第 10 轮。 */
  function loopingProvider(): { provider: LlmProvider; calls: LlmCompletionInput[] } {
    const calls: LlmCompletionInput[] = [];
    return {
      calls,
      provider: {
        name: "looping",
        modelVersion: "looping:v1",
        async complete(input) {
          calls.push(input);
          return { text: "", toolCalls: [{ id: `c${calls.length}`, name: "search_code", argumentsJson: JSON.stringify({ query: "zzz-不存在" }) }], finishReason: "tool_calls" as const };
        }
      }
    };
  }
  function spyChannel(log: string[], seen: TurnLoopState[]): TurnCheckpointChannel {
    return { restore: () => undefined, save: (_hash, state, reason) => { log.push(reason ?? "progress"); seen.push(state); }, clear: () => { log.push("clear"); } };
  }
  /** 重试那一路的假模型：modelVersion 与 `loopingProvider` 同一份，先取证再答完。 */
  function resumingProvider(): { provider: LlmProvider; calls: LlmCompletionInput[] } {
    const calls: LlmCompletionInput[] = [];
    let fired = 0;
    return {
      calls,
      provider: {
        name: "resuming",
        modelVersion: "looping:v1",
        async complete(input) {
          calls.push(input);
          fired += 1;
          return fired === 1
            ? { text: "", toolCalls: [{ id: "again1", name: "search_code", argumentsJson: JSON.stringify({ query: "zzz-不存在" }) }], finishReason: "tool_calls" as const }
            : { text: "接着读到的东西答完了。", finishReason: "stop" as const };
        }
      }
    };
  }

  it("轮次用完：不再发收尾那一趟，快照留着并写明原因", async () => {
    const { provider, calls } = loopingProvider();
    const log: string[] = [];
    const seen: TurnLoopState[] = [];
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "画张图", maxTokens: 700, temperature: 0, maxRounds: 3, maxCalls: 4, interruptAtLimit: true, checkpoint: spyChannel(log, seen) });
    expect(calls.length, "中断就不该再有收尾那一趟调用（那一趟是过去硬答一句的钱）").toBe(4);
    expect(result.interrupted).toMatchObject({ reason: "rounds" });
    expect(result.stoppedBy).toBe("rounds");
    expect(log.at(-1), "最后一份快照要写明是中断，报表才知道这行残局该被同一句重发接上").toBe("interrupted");
    expect(log, "中断不删快照：删了就没得重试").not.toContain("clear");
    const saved = seen[seen.length - 1].messages;
    const last = saved[saved.length - 1];
    expect(last.role, "未应答的 tool_call 必须先回一句实话，否则下次发出去是非法请求").toBe("tool");
    expect(String(last.content)).toContain("这一轮在这里中断");
  });

  it("预算到线：同一档结局、同一个原因位", async () => {
    const { provider, calls } = loopingProvider();
    const log: string[] = [];
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "画张图", maxTokens: 700, temperature: 0, maxRounds: 10, maxCalls: 4, interruptAtLimit: true, budgetGuard: () => "本仓本月预算（5）已经用完。", checkpoint: spyChannel(log, []) });
    expect(calls.length).toBe(1);
    expect(result.interrupted?.reason).toBe("budget");
    expect(result.interrupted?.detail).toContain("预算");
    expect(log).toEqual(["interrupted"]);
  });

  it("中断之后同一句重发：从留下的快照接上，不从头再读一遍", async () => {
    const states = new Map<string, { round: number; state: TurnLoopState }>();
    const channel: TurnCheckpointChannel = {
      restore: (key) => states.get(key),
      save: (key, state) => { states.set(key, { round: state.rounds, state }); },
      clear: () => { states.clear(); }
    };
    const once = loopingProvider();
    await completeWithReadTool({ provider: once.provider, repoPath, system: "s", user: "画张图", maxTokens: 700, temperature: 0, maxRounds: 1, maxCalls: 4, interruptAtLimit: true, checkpoint: channel });
    expect(states.size, "中断该留下一份快照").toBe(1);
    const again = resumingProvider();
    const resumed = await completeWithReadTool({ provider: again.provider, repoPath, system: "s", user: "画张图", maxTokens: 700, temperature: 0, maxRounds: 1, maxCalls: 4, interruptAtLimit: true, checkpoint: channel });
    expect(resumed.resumedFromRound, "同一句、同一模型、同一份系统提示 ⇒ 接得上，用户点重试不该是从头再来").toBe(1);
    const carried = again.calls[0].messages ?? [];
    expect(carried.some((message) => message.role === "tool" && message.content.includes("这一轮在这里中断")), "续跑的请求里得带着中断那一句，否则模型不知道自己是接着做的").toBe(true);
    expect(carried[0].content, "首轮那条装了上下文的 user 消息不能因续跑而丢").toBe("画张图");
    expect(resumed.completion.text).toBe("接着读到的东西答完了。");
  });

  it("点重试的那一次自己有整份轮数配额：不然它一开火就再撞同一道闸，那颗按钮是摆设", async () => {
    const states = new Map<string, { round: number; state: TurnLoopState }>();
    const channel: TurnCheckpointChannel = {
      restore: (key) => states.get(key),
      save: (key, state) => { states.set(key, { round: state.rounds, state }); },
      clear: () => { states.clear(); }
    };
    const stopped = await completeWithReadTool({ provider: loopingProvider().provider, repoPath, system: "s", user: "画张图", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 4, interruptAtLimit: true, checkpoint: channel });
    expect(stopped.interrupted?.reason).toBe("rounds");

    const again = resumingProvider();
    const resumed = await completeWithReadTool({ provider: again.provider, repoPath, system: "s", user: "画张图", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 4, interruptAtLimit: true, checkpoint: channel });
    expect(resumed.resumedFromRound, "接上的正是中断那一轮之后").toBe(2);
    // 中断那次已把累计轮数顶满：闸门按本次请求内的轮数判。
    expect(resumed.interrupted, "重试是「再给一次机会」，不是「再撞一次同一道闸」").toBeUndefined();
    expect(resumed.completion.text).toBe("接着读到的东西答完了。");
    expect(again.calls.length, "本次配额下真做了实事：一趟取证 + 一趟作答").toBe(2);
  });

  it("不开这一档就还是老结局：回绝掉挂着的调用，再发一趟不带工具的收尾", async () => {
    const { provider, calls } = loopingProvider();
    const log: string[] = [];
    const result = await completeWithReadTool({ provider, repoPath, system: "s", user: "画张图", maxTokens: 700, temperature: 0, maxRounds: 2, maxCalls: 4, checkpoint: spyChannel(log, []) });
    expect(calls.length, "两趟取证 + 回绝后收尾那一趟").toBe(4);
    expect(calls[3].tools, "收尾那一趟不带工具").toBeUndefined();
    expect(result.interrupted).toBeUndefined();
    expect(result.stoppedBy).toBe("rounds");
    expect(log, "不开这一档就照旧：两轮取证各存一份，答完清掉").toEqual(["progress", "progress", "clear"]);
  });
});

describe("completeWithOptionalSkills（出题与练习答疑的技能通道）", () => {
  const skills = { brief: "可用技能：demo —— 一套出题做法", bodyOf: (name: string) => (name === "demo" ? "做法：先判考点，再写一行断言。" : undefined) };

  it("没给技能通道就是单轮：请求里没有工具，也没有第二趟", async () => {
    const { provider, calls } = scriptedProvider([{ text: "题面。", usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" }]);
    const result = await completeWithOptionalSkills({ provider, system: "s", user: "u", maxTokens: 600, temperature: 0.4, scene: "practice.generate" });
    expect(calls.length).toBe(1);
    expect(calls[0].tools, "没装技能就不该多出任何工具").toBeUndefined();
    expect(calls[0].system).toBe("s");
    expect(result.skillReads).toEqual([]);
    expect(result.text).toBe("题面。");
  });

  it("给了技能：清单并进系统提示、只开放 read_skill，取完正文再答", async () => {
    const { provider, calls } = scriptedProvider([
      { text: "", toolCalls: [{ id: "c1", name: "read_skill", argumentsJson: JSON.stringify({ name: "demo" }) }], usage: { inputTokens: 100, outputTokens: 5 }, finishReason: "tool_calls" },
      { text: "按做法出的题。", usage: { inputTokens: 120, outputTokens: 40 }, finishReason: "stop" }
    ]);
    const result = await completeWithOptionalSkills({ provider, system: "s", user: "u", maxTokens: 600, temperature: 0.4, scene: "practice.generate", skills });
    expect(calls[0].system).toContain("可用技能：demo");
    expect((calls[0].tools ?? []).map((tool) => tool.name), "这一路没有仓库文件面，能取的只有技能正文").toEqual(["read_skill"]);
    expect(calls[1].messages?.some((message) => message.role === "tool" && message.content.includes("先判考点"))).toBe(true);
    expect(result.text).toBe("按做法出的题。");
    expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 45 });
    expect(result.skillReads).toEqual([{ skill: "demo", chars: 15, found: true }]);
  });
});

describe("ask_user（回合内提问：问句即本轮正文，快照留着等认领）", () => {
  const facets = ["range", "goal"] as ("range" | "goal")[];
  const askCall = (id: string, args: Record<string, unknown>): LlmCompletion => ({ text: "", toolCalls: [{ id, name: "ask_user", argumentsJson: JSON.stringify(args) }], finishReason: "tool_calls" });
  const base = { provider: undefined as unknown as LlmProvider, repoPath, system: "s", user: "画张图", maxTokens: 700, temperature: 0, maxRounds: 4, maxCalls: 4 };
  /** 照 `turn_checkpoint` 的取行口径重演：哈希那条路跳过 `await_user`。 */
  function fakeStore() {
    const rows: { inputHash: string; stoppedReason?: string; promptHash?: string; pendingToolCallId?: string; state: TurnLoopState }[] = [];
    return {
      rows,
      channel: {
        restore: (inputHash) => {
          const hit = rows.filter((row) => row.stoppedReason !== "await_user" && row.inputHash === inputHash).at(-1);
          return hit ? { round: hit.state.rounds, state: hit.state } : undefined;
        },
        claimAsk: (pendingToolCallId, promptHash) => {
          const hit = rows.find((row) => row.pendingToolCallId === pendingToolCallId);
          if (!hit) return undefined;
          // 取到即删，与 `claim` 同口径。
          rows.splice(rows.indexOf(hit), 1);
          return hit.promptHash === promptHash ? { round: hit.state.rounds, state: hit.state } : undefined;
        },
        save: (inputHash: string, state: TurnLoopState, stoppedReason?: string, ask?: { promptHash: string; pendingToolCallId: string }) => {
          rows.push({ inputHash, state, ...(stoppedReason ? { stoppedReason } : {}), ...(ask ?? {}) });
        },
        clear: () => { rows.length = 0; }
      } satisfies TurnCheckpointChannel
    };
  }
  const question = { facet: "range", question: "这张图画哪一块？", options: ["整仓", "下单那条"] };

  it("问一句就不再发第二次调用；正文是「问句 + 可选项」；只留一份等回答的快照", async () => {
    const { provider, calls } = scriptedProvider([askCall("a1", question)]);
    const store = fakeStore();
    const result = await completeWithReadTool({ ...base, provider, ask: { facets }, checkpoint: store.channel });
    expect(calls.length, "提问就是本轮成品，不该再烧一趟调用").toBe(1);
    expect(result.completion.text).toBe("这张图画哪一块？\n可选项：整仓 / 下单那条");
    expect(result.asked).toEqual({ ...question, toolCallId: "a1" });
    expect(store.rows).toEqual([{ inputHash: expect.any(String), state: expect.any(Object), stoppedReason: "await_user", promptHash: expect.any(String), pendingToolCallId: "a1" }]);
  });

  it("认领一句提问：答句回灌到挂着的那条调用，接着算而不是从头再来", async () => {
    const store = fakeStore();
    const first = scriptedProvider([askCall("a1", question)]);
    await completeWithReadTool({ ...base, provider: first.provider, ask: { facets }, checkpoint: store.channel });

    const again = scriptedProvider([{ text: "那就画下单那条。", finishReason: "stop" }]);
    const result = await completeWithReadTool({ ...base, provider: again.provider, ask: { facets, resume: { toolCallId: "a1", answer: "下单那条" } }, checkpoint: store.channel });
    expect(result.askClaimed).toEqual({ toolCallId: "a1", outcome: "claimed" });
    expect(result.resumedFromRound, "认领回到的正是问出那句的那一轮").toBe(1);
    expect(again.calls.length, "接上之后只发这一趟：已读过的上下文不该重付").toBe(1);
    const carried = again.calls[0].messages ?? [];
    expect(carried[0].content, "首轮那条装了上下文的 user 消息不能因续跑而丢").toBe("画张图");
    expect(carried.at(-1), "答句是那条调用的回执，不是新的一句话").toEqual({ role: "tool", toolCallId: "a1", content: "下单那条" });
    expect(result.completion.text).toBe("那就画下单那条。");
  });

  it("同一句原样重发绝不接上「等回答」的快照", async () => {
    const store = fakeStore();
    const first = scriptedProvider([askCall("a1", question)]);
    await completeWithReadTool({ ...base, provider: first.provider, ask: { facets }, checkpoint: store.channel });
    const again = scriptedProvider([{ text: "按整仓画。", finishReason: "stop" }]);
    const result = await completeWithReadTool({ ...base, provider: again.provider, ask: { facets }, checkpoint: store.channel });
    expect(result.resumedFromRound, "重发走的是哈希那条路：接到一句没人答的提问上，模型会以为自己已经问过了").toBeUndefined();
    expect(again.calls[0].user).toBe("画张图");
  });

  it("换了模型就不认领：老实重跑，并把「没认上」报出去", async () => {
    const store = fakeStore();
    const first = scriptedProvider([askCall("a1", question)]);
    await completeWithReadTool({ ...base, provider: first.provider, ask: { facets }, checkpoint: store.channel });
    const otherModel: LlmProvider = { name: "scripted", modelVersion: "scripted:v2", complete: async () => ({ text: "整仓三层。", finishReason: "stop" }) };
    const result = await completeWithReadTool({ ...base, provider: otherModel, ask: { facets, resume: { toolCallId: "a1", answer: "整仓" } }, checkpoint: store.channel });
    expect(result.askClaimed).toEqual({ toolCallId: "a1", outcome: "missed" });
    expect(result.resumedFromRound, "另一家模型的中间状态接过来就是答非所问").toBeUndefined();
    expect(result.completion.text).toBe("整仓三层。");
  });

  it("同一批里排在被问调用之后的调用先拿到一句实话：认领时的消息数组才合法", async () => {
    const store = fakeStore();
    const first = scriptedProvider([{
      text: "",
      toolCalls: [
        { id: "a1", name: "ask_user", argumentsJson: JSON.stringify(question) },
        { id: "r1", name: "read_file", argumentsJson: JSON.stringify({ path: "tool-loop.ts" }) }
      ],
      finishReason: "tool_calls"
    }]);
    await completeWithReadTool({ ...base, provider: first.provider, ask: { facets }, checkpoint: store.channel });

    const again = scriptedProvider([{ text: "整仓三层。", finishReason: "stop" }]);
    await completeWithReadTool({ ...base, provider: again.provider, ask: { facets, resume: { toolCallId: "a1", answer: "整仓" } }, checkpoint: store.channel });
    const carried = again.calls[0].messages ?? [];
    const asked = carried.flatMap((message) => message.toolCalls ?? []).map((call) => call.id).sort();
    const replies = carried.filter((message) => message.role === "tool").map((message) => message.toolCallId).sort();
    expect(replies, "认领发出去的那一趟，每个调用都要有回执（悬挂的会被协议层拒）").toEqual(asked);
    expect(carried.filter((message) => message.toolCallId === "r1"), "同一条调用只许有一份回执").toHaveLength(1);
    expect(carried.some((message) => message.toolCallId === "r1" && String(message.content).includes("这一条没有执行"))).toBe(true);
  });

  it("一句里塞两个提问：只认第一个，第二句不但不执行也不再发调用", async () => {
    const { provider, calls } = scriptedProvider([{
      text: "",
      toolCalls: [
        { id: "a1", name: "ask_user", argumentsJson: JSON.stringify({ facet: "goal", question: "要给谁看？", options: ["新人", "评审"] }) },
        { id: "a2", name: "ask_user", argumentsJson: JSON.stringify({ facet: "range", question: "画哪一块？", options: ["整仓"] }) }
      ],
      finishReason: "tool_calls"
    }]);
    const result = await completeWithReadTool({ ...base, provider, ask: { facets } });
    expect(calls.length).toBe(1);
    expect(result.asked?.question, "一轮最多问一句").toBe("要给谁看？");
  });

  it("候选太长就挡下：回一句实话，模型照样能答完，原因进审计", async () => {
    const { provider, calls } = scriptedProvider([
      askCall("a1", { facet: "range", question: "画哪一块？", options: ["把整条下单链路和它的异步任务都画上"] }),
      { text: "那就先画整仓三层。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ ...base, provider, ask: { facets } });
    expect(result.asked, "超限的提问不成立").toBeUndefined();
    expect(result.askRefused).toContain("按钮放不下");
    expect(calls.length, "挡下之后回合继续，不是一报错就散").toBe(2);
    expect(calls[1].messages?.some((message) => message.role === "tool" && message.content.includes("按钮放不下")), "挡下的理由必须回给模型，不然它只会重复试").toBe(true);
    expect(result.completion.text).toBe("那就先画整仓三层。");
  });

  it("问本轮并不缺的那一格：挡下", async () => {
    const { provider, calls } = scriptedProvider([
      askCall("a1", { facet: "goal", question: "要给谁看？", options: ["新人"] }),
      { text: "按分层给。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ ...base, provider, ask: { facets: ["range"] } });
    expect(result.askRefused).toContain("本轮能问的只有 range");
    expect(result.asked).toBeUndefined();
  });

  it("没给提问通道时，工具清单里没有它；模型硬调就回一句「这一轮没有这个通道」", async () => {
    const { provider, calls } = scriptedProvider([
      askCall("a1", { facet: "range", question: "画哪一块？", options: ["整仓"] }),
      { text: "整仓三层。", finishReason: "stop" }
    ]);
    const result = await completeWithReadTool({ ...base, provider });
    expect(calls[0].tools?.some((tool) => tool.name === "ask_user"), "默认关 = 清单里一个字节都不多").toBe(false);
    expect(calls[1].messages?.some((message) => message.role === "tool" && message.content.includes("没有向用户提问的通道"))).toBe(true);
    expect(result.asked).toBeUndefined();
  });
});
