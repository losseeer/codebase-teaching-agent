import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exercise, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { buildSearchCorpus } from "../source/search-code.js";
import { mapChat, practiceChat, type MapChatProgress, type ScopedChatTurn } from "./scopechat.js";

function fakeProvider(): { provider: LlmProvider; calls: LlmCompletionInput[] } {
  const calls: LlmCompletionInput[] = [];
  const provider: LlmProvider = {
    name: "fake-provider",
    modelVersion: "fake:model",
    async complete(input: LlmCompletionInput): Promise<LlmCompletion> {
      calls.push(input);
      return { text: "好的，基于上下文回答。", usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop" };
    }
  };
  return { provider, calls };
}

const analysis = {
  repositoryId: "repo_test",
  generatedAt: new Date().toISOString(),
  graph: {
    imports: {
      "src/app.ts": ["src/config.ts"],
      "src/config.ts": ["src/paths.ts"],
      "src/boot.ts": ["src/app.ts"],
      "src/ui/theme.ts": ["src/boot.ts"],
      "src/utils/normalize.ts": ["src/config.ts"]
    },
    calls: [], symbols: [], entrypoints: [],
    semanticBackend: "static", lspStatus: []
  },
  implementations: [],
  versionStamp: "v1"
} as unknown as RepositoryAnalysis;

const exercise = {
  id: "ex1",
  kind: "change_localization",
  title: "修改定位",
  prompt: "需要修改 bootstrap 的局部行为，选择必须首先修改的源码文件。",
  inputMode: "multi_select",
  gradingMode: "set_match",
  options: [
    { id: "a", label: "src/app.ts" },
    { id: "b", label: "src/config.ts" }
  ],
  anchors: [{ path: "src/app.ts", line: 4 }],
  contentVersion: "v1",
  targetUnitId: "u1",
  createdAt: new Date().toISOString()
} as unknown as Exercise;

describe("mapChat", () => {
  it("上下文包含作用域文件与依赖关系，回复与 usage 透传", async () => {
    const { provider, calls } = fakeProvider();
    const result = await mapChat({
      repoPath: import.meta.dirname,
      analysis,
      scopePaths: ["src/app.ts"],
      path: "src/app.ts",
      content: "为什么要分层？",
      provider,
      style: 50
    });
    expect(result.reply).toContain("基于上下文");
    expect(result.provider).toBe("fake-provider");
    expect(result.usage?.inputTokens).toBe(10);
    const user = calls[0].user;
    expect(user).toContain("项目结构全景");
    expect(user).toContain("src/utils/（1）：normalize.ts"); // 全景按目录分组列出已分析文件
    expect(user).toContain("当前作用域：学习者在架构图选中的模块，含 1 个已分析文件");
    expect(user).toContain("src/app.ts");
    expect(user).toContain("src/config.ts"); // 一度邻居
    expect(user).toContain("src/paths.ts"); // 二度下游：config.ts 的 import
    expect(user).toContain("src/boot.ts"); // 一度上游
    expect(user).toContain("src/ui/theme.ts"); // 二度上游：boot.ts 的被 import
    expect(user).toContain("为什么要分层？");
  });

  it("工具循环：模型请求 read_file → 引擎执行并回喂 → 汇总 usage 与 fileReads", async () => {
    const script: LlmCompletion[] = [
      { text: "", toolCalls: [{ id: "call_a", name: "read_file", argumentsJson: JSON.stringify({ path: "scopechat.ts" }) }], usage: { inputTokens: 100, outputTokens: 20 }, finishReason: "tool_calls" },
      { text: "读完文件后的回答。", usage: { inputTokens: 200, outputTokens: 30 }, finishReason: "stop" }
    ];
    const calls: LlmCompletionInput[] = [];
    const progressEvents: MapChatProgress[] = [];
    let index = 0;
    const provider: LlmProvider = {
      name: "scripted",
      modelVersion: "scripted:model",
      async complete(input) {
        calls.push(input);
        return script[index++] ?? script[script.length - 1];
      }
    };
    const result = await mapChat({
      repoPath: import.meta.dirname,
      analysis,
      path: "src/app.ts",
      content: "scopechat.ts 里定义了什么？",
      provider,
      style: 50,
      onProgress: (progress) => progressEvents.push(progress)
    });
    expect(result.reply).toContain("读完文件后的回答");
    expect(progressEvents).toEqual([
      { type: "thinking", round: 1 },
      { type: "reading", path: "scopechat.ts" },
      { type: "thinking", round: 2 }
    ]);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 50 });
    /*
      不给 limit 就一次读到字符预算为止（预算按窗口派生，1M 窗口下整份源码都在里面）：
      实得行数必须等于文件真实行数，且 truncated=false —— 这条钉住「默认只给 150 行」那个旧行为没回来。
    */
    const wholeFileLines = readFileSync(join(import.meta.dirname, "scopechat.ts"), "utf8").split(/\r?\n/).length;
    const reads = result.fileReads ?? [];
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ path: "scopechat.ts", lines: wholeFileLines, truncated: false, denied: false });
    const second = calls[1];
    expect(second.messages?.[0]).toMatchObject({ role: "user" });
    expect(second.messages?.[0].content).toContain("项目结构全景"); // 回归：工具轮次后不得丢失代码上下文
    expect(second.messages?.[0].content).toContain("scopechat.ts 里定义了什么？"); // 回归：不得丢失原始提问
    expect(second.messages?.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "read_file")).toBe(true);
    const toolResult = second.messages?.find((m) => m.role === "tool");
    expect(toolResult?.content).toContain("1| ");
    expect(toolResult?.content).toContain("export");
    expect(calls[0].tools?.[0]?.name).toBe("read_file");
  });

  it("query_facts 这一门：清单里有它、闭包的回话原样喂给模型、且不占读文件额度", async () => {
    const script: LlmCompletion[] = [
      { text: "", toolCalls: [{ id: "call_f", name: "query_facts", argumentsJson: JSON.stringify({ kind: "cfg", path: "src/app.ts" }) }], usage: { inputTokens: 100, outputTokens: 10 }, finishReason: "tool_calls" },
      { text: "按产物说的回答。", usage: { inputTokens: 120, outputTokens: 20 }, finishReason: "stop" }
    ];
    const calls: LlmCompletionInput[] = [];
    let index = 0;
    const provider: LlmProvider = {
      name: "scripted",
      modelVersion: "scripted:model",
      async complete(input) {
        calls.push(input);
        return script[index++] ?? script[script.length - 1];
      }
    };
    const result = await mapChat({
      repoPath: import.meta.dirname,
      analysis,
      path: "src/app.ts",
      content: "这个函数的分支长什么样？",
      provider,
      style: 50,
      facts: { inventory: "静态产物在册：cfg 3 文件。", apply: () => "语言 typescript，backend ast\npick@3-5 复杂度 2，块 6、边 6" }
    });
    expect(result.reply).toContain("按产物说的回答");
    expect(calls[0].tools?.map((tool) => tool.name)).toContain("query_facts");
    // 有副作用的工具要先看见现状，只读的门同理：产物在册情况得进上下文，否则模型不知道有什么可查
    expect(calls[0].user ?? calls[0].messages?.[0]?.content ?? "").toContain("静态产物在册");
    const second = calls[1];
    expect(second.messages?.find((m) => m.role === "tool")?.content).toContain("复杂度 2");
    expect(result.fileReads ?? [], "查产物不是读源码，一行文件额度都不该占").toEqual([]);
  });

  it("回合内压缩：第 3 轮起最早那轮的正文折掉、抬头留着，早期 reasoning 丢弃而最近一轮原样回传", async () => {
    const script: LlmCompletion[] = [
      { text: "", toolCalls: [{ id: "call_a", name: "read_file", argumentsJson: JSON.stringify({ path: "scopechat.ts" }) }], reasoningContent: "思考A1", usage: { inputTokens: 100, outputTokens: 20 }, finishReason: "tool_calls" },
      { text: "", toolCalls: [{ id: "call_b", name: "read_file", argumentsJson: JSON.stringify({ path: "scopechat.test.ts" }) }], reasoningContent: "思考A2", usage: { inputTokens: 150, outputTokens: 25 }, finishReason: "tool_calls" },
      { text: "", toolCalls: [{ id: "call_c", name: "read_file", argumentsJson: JSON.stringify({ path: "scopechat.ts" }) }], reasoningContent: "思考A3", usage: { inputTokens: 150, outputTokens: 25 }, finishReason: "tool_calls" },
      { text: "三轮后的回答。", usage: { inputTokens: 200, outputTokens: 30 }, finishReason: "stop" }
    ];
    const calls: LlmCompletionInput[] = [];
    let index = 0;
    const provider: LlmProvider = {
      name: "scripted",
      modelVersion: "scripted:model",
      async complete(input) {
        calls.push(input);
        return script[index++] ?? script[script.length - 1];
      }
    };
    const result = await mapChat({ repoPath: import.meta.dirname, analysis, path: "src/app.ts", content: "两个文件的实现差异？", provider, style: 50 });
    expect(result.reply).toContain("三轮后的回答");
    /*
      保留窗口是 2 轮（`TOOL_CONTEXT_KEEP_ROUNDS`）：第 4 次请求带着 3 轮历史，最早那轮该折掉。
      别拿 calls[1]、calls[2] 判「更早的请求长什么样」——它们与本条引用的是同一个 messages 数组，
      就地折叠会同时改到所有已记录的请求上。
    */
    const fourth = calls[3];
    const toolResults = fourth.messages?.filter((m) => m.role === "tool") ?? [];
    expect(toolResults).toHaveLength(3);
    // 最早一轮：正文换占位符，但「哪个文件、第几到第几行」留着
    expect(toolResults[0].content).toContain("已折叠");
    expect(toolResults[0].content).toContain("文件 scopechat.ts");
    expect(toolResults[0].content.split("\n").length).toBeLessThanOrEqual(3);
    expect(toolResults[0].content.length).toBeLessThan(400);
    /*
      判「这一条是原文」不能靠「不含某个短语」：夹具读的就是本文件，占位符里那串字本来就在源码里。
      改判形状——整份原文有几百行，被折叠过的只剩抬头加一句说明。
    */
    for (const kept of toolResults.slice(1)) expect(kept.content.split("\n").length).toBeGreaterThan(200);
    // 早期 assistant 的 reasoningContent 丢弃；最近一轮保留（协议要求 tool 轮回传）
    const assistants = fourth.messages?.filter((m) => m.role === "assistant") ?? [];
    expect(assistants.slice(0, 2).every((m) => m.reasoningContent === undefined)).toBe(true);
    expect(assistants[2].reasoningContent).toBe("思考A3");
  });

  it("回复达到预算上限：finishReason=length 时尾附截断声明，半截句子不裸奔", async () => {
    const provider: LlmProvider = {
      name: "capped",
      modelVersion: "capped:model",
      async complete(): Promise<LlmCompletion> {
        return { text: "这句话说到一半就被", usage: { inputTokens: 10, outputTokens: 1_000 }, finishReason: "length" };
      }
    };
    const result = await mapChat({ repoPath: import.meta.dirname, analysis, content: "讲详细点", provider, style: 50 });
    expect(result.reply).toBe("这句话说到一半就被\n\n（回复因达到输出长度上限被截断，说「继续」可以接着讲。）");
  });

  it("画布上送作用域：只注入已分析路径的「当前作用域」清单（含 L1 职责），未分析路径被丢弃", async () => {
    const { provider, calls } = fakeProvider();
    const index = { repositoryId: "repo_test", files: [{ path: "src/app.ts", lines: 120 }, { path: "src/config.ts", lines: 30 }] } as unknown as RepositoryIndex;
    const search = buildSearchCorpus(index, analysis, new Map([["src/app.ts", "装配应用入口"], ["src/config.ts", "读取并校验配置"]]));
    await mapChat({ repoPath: import.meta.dirname, analysis, scopePaths: ["src/app.ts", "src/config.ts", "README.md"], content: "这个模块依赖谁？", provider, style: 50, search });
    const user = calls[0].user;
    expect(user).toContain("当前作用域：学习者在架构图选中的模块，含 2 个已分析文件");
    expect(user).toContain("src/app.ts（120 行）：装配应用入口");
    expect(user).not.toContain("README.md"); // 未分析的提示路径不参与交集
  });

  it("作用域清单全部未分析 → 不注入作用域段，按全局视野作答", async () => {
    const { provider, calls } = fakeProvider();
    await mapChat({ repoPath: import.meta.dirname, analysis, scopePaths: ["nowhere/x.ts", "nowhere/y.ts", "nowhere/x.ts"], content: "问", provider, style: 50 });
    expect(calls[0].user).toContain("项目结构全景");
    expect(calls[0].user).not.toContain("当前作用域");
  });

  it("作用域文件数超上限 → 逐个列前 60 并明示余量与 search_code 出口", async () => {
    const { provider, calls } = fakeProvider();
    const files = Array.from({ length: 65 }, (_, i) => `src/mod/f${i}.ts`);
    const wide = { ...analysis, graph: { ...analysis.graph, imports: Object.fromEntries(files.map((file) => [file, []])) } } as unknown as RepositoryAnalysis;
    await mapChat({ repoPath: import.meta.dirname, analysis: wide, scopePaths: files, content: "问", provider, style: 50 });
    const user = calls[0].user;
    expect(user).toContain("含 65 个已分析文件");
    expect(user).toContain("其余 5 个文件未列出");
  });

  it("最近对话窗口：按时间序注入在代码上下文与问题之间，历史原文不逐轮截断，空内容不生成行", async () => {
    const { provider, calls } = fakeProvider();
    await mapChat({
      repoPath: import.meta.dirname, analysis, content: "第二点再展开讲", provider, style: 50,
      history: [
        { role: "user", content: "这个模块的分层有哪些？" },
        { role: "assistant", content: "长".repeat(500) },
        { role: "user", content: "   \n  " }
      ]
    });
    const user = calls[0].user ?? "";
    expect(user).toContain("最近对话（此前轮次，按时间序");
    expect(user).toContain("学习者: 这个模块的分层有哪些？");
    expect(user).toContain("长".repeat(500));
    expect(user.indexOf("最近对话")).toBeLessThan(user.indexOf("学习者的问题：第二点再展开讲"));
    expect(user.indexOf("最近对话")).toBeGreaterThan(user.indexOf("项目结构全景"));
    // 空内容轮不生成行：整块只有 学习者/助手 两行
    expect(user.match(/(学习者|助手): /g)?.filter((line) => line === "助手: ").length).toBe(1);
  });

  it("窗口还宽时历史整段留着（不再只取最后 6 条）；无历史不注入空段", async () => {
    const { provider, calls } = fakeProvider();
    const turns = Array.from({ length: 8 }, (_, i): ScopedChatTurn => ({ role: i % 2 ? "assistant" : "user", content: `轮次${i}` }));
    await mapChat({ repoPath: import.meta.dirname, analysis, content: "问", history: turns, provider, style: 50 });
    for (const turn of turns) expect(calls[0].user).toContain(turn.content);
    const fresh = fakeProvider();
    await mapChat({ repoPath: import.meta.dirname, analysis, content: "首问", provider: fresh.provider, style: 50 });
    expect(fresh.calls[0].user).not.toContain("最近对话");
  });

  it("历史装不下本轮空间时才折：留最早与最近、中间换占位，本轮引用到的那条按词法找回", async () => {
    const previous = process.env.TUTOR_CONTEXT_WINDOW_TOKENS;
    // 10000 token = 40000 字符，对话份额 5% = 2000 字符：下面这份历史约 2200 字符，超出本轮分给它的安全空间
    process.env.TUTOR_CONTEXT_WINDOW_TOKENS = "10000";
    try {
      const { provider, calls } = fakeProvider();
      const history: ScopedChatTurn[] = [
        { role: "user", content: "开场：这个仓怎么分层" },
        { role: "assistant", content: "开场答：按主干、设施、外部三档。" },
        { role: "user", content: `中段一问${"聊".repeat(300)}` },
        { role: "assistant", content: `中段一答${"聊".repeat(300)}` },
        { role: "assistant", content: "装配清单里有一处 蓝绿发布锚点：它落在 registry.ts。" },
        { role: "user", content: `中段二问${"聊".repeat(300)}` },
        { role: "assistant", content: `中段二答${"聊".repeat(300)}` },
        { role: "user", content: `中段三问${"聊".repeat(300)}` },
        { role: "assistant", content: `中段三答${"聊".repeat(300)}` },
        { role: "user", content: `中段四问${"聊".repeat(300)}` },
        { role: "user", content: "最近的问题" },
        { role: "assistant", content: "最近的回答" }
      ];
      const result = await mapChat({ repoPath: import.meta.dirname, analysis, content: "蓝绿发布锚点在哪一行？", history, provider, style: 50 });
      const user = calls[0].user ?? "";
      expect(user).toContain("开场：这个仓怎么分层");
      expect(user).toContain("最近的回答");
      expect(user).toContain("中间 4 条对话已折叠");
      expect(user).not.toContain("中段一问");
      expect(user).toContain("蓝绿发布锚点：它落在 registry.ts");
      expect(result.conversation).toMatchObject({ recalledMessages: 1, foldedMessages: 3 });
    } finally {
      if (previous === undefined) delete process.env.TUTOR_CONTEXT_WINDOW_TOKENS;
      else process.env.TUTOR_CONTEXT_WINDOW_TOKENS = previous;
    }
  });
});

describe("practiceChat", () => {
  it("上下文包含题面与选项，但不含判分答案", async () => {
    const { provider, calls } = fakeProvider();
    const result = await practiceChat({
      repoPath: import.meta.dirname,
      exercise,
      content: "为什么不是 config.ts？",
      provider,
      style: 50
    });
    const user = calls[0].user;
    expect(user).toContain("修改定位");
    expect(user).toContain("src/app.ts");
    expect(user).toContain("为什么不是 config.ts？");
    // 学习者安全：expected / answerKey 不允许进入 prompt
    expect(user).not.toContain("expectedIds");
    expect(user).not.toContain("answerKey");
    expect(result.reply).toContain("基于上下文");
  });

  it("最近对话注入在题面上下文与追问之间；无历史不注入空段", async () => {
    const { provider, calls } = fakeProvider();
    await practiceChat({
      repoPath: import.meta.dirname, exercise, content: "为什么不是 app.ts？", provider, style: 50,
      history: [{ role: "user", content: "这题选什么？" }, { role: "assistant", content: "建议选 config.ts，因为装配从它读起。" }]
    });
    const user = calls[0].user ?? "";
    expect(user).toContain("学习者: 这题选什么？");
    expect(user).toContain("助手: 建议选 config.ts");
    expect(user.indexOf("最近对话")).toBeGreaterThan(user.indexOf("练习上下文："));
    expect(user.indexOf("最近对话")).toBeLessThan(user.indexOf("学习者的追问："));
    const fresh = fakeProvider();
    await practiceChat({ repoPath: import.meta.dirname, exercise, content: "问", provider: fresh.provider, style: 50 });
    expect(fresh.calls[0].user).not.toContain("最近对话");
  });
});

describe("作用域 prompt 单源（风格档位进入系统提示词）", () => {
  it("map：风格档位进入 system prompt，与代码教学共用同一份 styleBrief", async () => {
    const { provider, calls } = fakeProvider();
    await mapChat({ repoPath: import.meta.dirname, analysis, path: "src/app.ts", content: "一次请求怎么走？", provider, style: 90 });
    expect(calls[0].system).toContain("通俗讲解风格");
    expect(calls[0].system).toContain("类比");
    expect(calls[0].system).toContain("宏观设计");
  });

  it("practice：低档位走严谨侧，且仍不透露判分标准", async () => {
    const { provider, calls } = fakeProvider();
    await practiceChat({ repoPath: import.meta.dirname, exercise, content: "为什么？", provider, style: 10 });
    expect(calls[0].system).toContain("工程评审式严谨风格");
    expect(calls[0].system).toContain("直接证据");
    expect(calls[0].system).toContain("判分标准没有提供给你");
  });
});
