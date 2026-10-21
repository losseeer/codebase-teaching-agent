import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmMessage, LlmProvider } from "../llm/provider.js";
import { LlmAbortedError } from "../llm/provider.js";
import { buildSearchCorpus } from "./search-code.js";
import { TOOL_CONTEXT_KEEP_ROUNDS, compactTurnContext, completeWithReadTool, toolLoopAuditsOf, type TurnCheckpointChannel, type TurnLoopState } from "./tool-loop.js";

/** repoPath 指向本目录：目录内 read-file.ts 是稳定存在的真实文件 */
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
    expect(result.fileReads.map((read) => read.path)).toEqual(["read-file.ts"]);
    expect(result.usage).toEqual({ inputTokens: 250, outputTokens: 40 });
    // 收尾轮不再带工具，并以回绝文本应答第二次调用
    expect(calls[2].tools).toBeUndefined();
    const refusal = calls[2].messages?.find((message) => message.role === "tool" && message.content.includes("工具轮次已用完"));
    expect(refusal?.content, "到限的是轮数，回话就不能说成读文件上限——模型会把这句转述给学习者").toContain("读文件额度还剩 4 次");
    // 收尾这一次是本回合最后一次调用：折叠换来的省没有下一轮可享，读到的正文必须原样在场
    const readBody = calls[2].messages?.find((message) => message.role === "tool" && message.content.startsWith("文件 "));
    expect(readBody?.content, "到闸收尾把正文抽成占位符，这一回合就交不出东西").not.toContain("已折叠");
    // 首轮 user 消息始终在 messages[0]（工具轮次后不丢上下文与提问）
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
    // 两次都进审计（拒绝也要留痕），但只有成功那次占用额度
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
    // miss 字段两边都没上报 → 整个缺席，而不是 0（「没上报」≠「没命中」）
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

  /**
    拦的事故：回合按作废收尾时把「这一轮真做过什么」连同异常一起丢掉，journal 就留下一行
    「什么都没读、什么都没打」的假账——读文件与外部调用确实发生过、内容确实出过门。
    这里测的是异常携带那半条；返回值携带那半条（中止晚于最后一趟 LLM）由路由级用例守。
    */
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
    // symbol 键：provider 与 GUI 看到的错误形状不能因为这份旁证而变（和一条裸的中止错误逐字同形）
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
        // 第一趟读一个能读的、被护栏拒一个；第二趟回来时用户已经点了停止
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
    // 被护栏拒读的那次也要留痕：它同样是「已经发生过」，只是没拿到内容
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
    // maxCalls=1 只被那次成功的 read 用掉——检索没读任何文件
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

/**
  跨仓那一档（跨仓只经由这三个工具发生）。
  要拦的事故：换根时把守卫也换掉（对端仓的 .env 就该照样拒）、未知仓名让模型原地打转、
  以及「没有第二个仓时工具清单悄悄变长」——那会让每次对话都多带一段没用的 schema。
*/
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
    // c2 成功占掉唯一的跨仓额度，c3 被掐住：只有一条真实读取，另一条是额度提示
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
    // 只有真读到的对端文件算「递给过模型」；被拒的 .env 与本仓文件都不进这份登记
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
    // 装了但正文为空 ≠ 没装：found 必须还是 true，模型才不会回用户一句「这个技能不存在」
    const blank = await completeWithReadTool({
      provider: scriptedProvider([{ text: "", toolCalls: [{ id: "b1", name: "read_skill", argumentsJson: JSON.stringify({ name: "empty-skill" }) }], finishReason: "tool_calls" }, { text: "答。", finishReason: "stop" }]).provider,
      repoPath, system: "s", user: "u", maxTokens: 100, temperature: 0, maxRounds: 2, maxCalls: 2,
      skills: { brief: "可用技能：\n- empty-skill：一份还没写正文的技能。", bodyOf: (name) => (name === "empty-skill" ? "" : undefined) }
    });
    expect(blank.skillReads).toEqual([{ skill: "empty-skill", chars: 0, found: true }]);
    // 「清单里有名字、正文从没被取走」只能从这一行看出来，所以 found:false 必须照样记
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

/**
  回合内压缩的两条口径。两个方向都要拦：留太多是同一份正文逐轮重付，留太少是模型以为自己没读过——
  于是重复读同一段、或者对用户说「读取失败」。
*/
describe("compactTurnContext", () => {
  /** 一条真实的读取结果形状：抬头写明文件与行区间，正文撑到足够长才会被折叠。 */
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
    // tool_calls 骨架不能跟着折叠一起摘掉：摘了它，后面那条 tool 消息就悬空，请求直接不合法
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

/**
  中断恢复（照 LangGraph 的 checkpoint：一个 super-step 一份快照，同一线程续跑）与每轮开火前的预算复查。
  要拦的事故：答完了还留着残局（下次误续一个已经结束的回合）、用户点了停止却留下残局
  （替他续跑是违背意图）、预算到线后继续一轮轮往上加钱。
*/
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

  /** 记账用的假通道：断言「什么时候写、写了什么、有没有清」都靠它。 */
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
    // 额度 2：残局已用掉 1 次成功读取，这一轮再用掉第 2 次，之后没有额度就收尾
    expect(result.fileReads.map((read) => read.path)).toEqual(["read-file.ts", "tool-loop.ts"]);
    expect(result.rounds).toBe(2);
    // 两趟调用：残局之后接着开的一轮、和模型答完的那一趟——首轮不再重放
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
