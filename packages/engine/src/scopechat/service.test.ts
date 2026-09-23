import { describe, expect, it } from "vitest";
import type { Exercise, RepositoryAnalysis, RepositoryIndex } from "@codebase-tutor/shared";
import type { LlmCompletion, LlmCompletionInput, LlmProvider } from "../llm/provider.js";
import { buildSearchCorpus } from "../source/search-code.js";
import { mapChat, practiceChat, type MapChatProgress, type ScopedChatTurn } from "./service.js";

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
  quality: {},
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
  it("上下文包含节点摘要与依赖关系，回复与 usage 透传", async () => {
    const { provider, calls } = fakeProvider();
    const result = await mapChat({
      repoPath: import.meta.dirname,
      analysis,
      node: { id: "n1", title: "启动流程", summary: "应用入口的装配顺序", kind: "workflow", anchors: [], children: [] },
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
    expect(user).toContain("启动流程");
    expect(user).toContain("src/app.ts");
    expect(user).toContain("src/config.ts"); // 一度邻居
    expect(user).toContain("src/paths.ts"); // 二度下游：config.ts 的 import
    expect(user).toContain("src/boot.ts"); // 一度上游
    expect(user).toContain("src/ui/theme.ts"); // 二度上游：boot.ts 的被 import
    expect(user).toContain("为什么要分层？");
  });

  it("工具循环：模型请求 read_file → 引擎执行并回喂 → 汇总 usage 与 fileReads", async () => {
    const script: LlmCompletion[] = [
      { text: "", toolCalls: [{ id: "call_a", name: "read_file", argumentsJson: JSON.stringify({ path: "service.ts" }) }], usage: { inputTokens: 100, outputTokens: 20 }, finishReason: "tool_calls" },
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
      content: "service.ts 里定义了什么？",
      provider,
      style: 50,
      onProgress: (progress) => progressEvents.push(progress)
    });
    expect(result.reply).toContain("读完文件后的回答");
    expect(progressEvents).toEqual([
      { type: "thinking", round: 1 },
      { type: "reading", path: "service.ts" },
      { type: "thinking", round: 2 }
    ]);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 50 });
    expect(result.fileReads).toEqual([{ path: "service.ts", lines: 150, bytes: expect.any(Number), truncated: false, denied: false }]); // 请求的 150 行一行不少 → truncated=false；「文件还有后面」由首行的「共 N 行」表达（口径同 excerpt.ts）
    // 第二轮请求携带完整历史：原始 user 消息（上下文+问题）+ assistant toolCalls + tool 结果（带行号的真实文件内容）
    const second = calls[1];
    expect(second.messages?.[0]).toMatchObject({ role: "user" });
    expect(second.messages?.[0].content).toContain("项目结构全景"); // 回归：工具轮次后不得丢失代码上下文
    expect(second.messages?.[0].content).toContain("service.ts 里定义了什么？"); // 回归：不得丢失原始提问
    expect(second.messages?.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "read_file")).toBe(true);
    const toolResult = second.messages?.find((m) => m.role === "tool");
    expect(toolResult?.content).toContain("1| ");
    expect(toolResult?.content).toContain("export");
    // 首轮请求带 tools 定义
    expect(calls[0].tools?.[0]?.name).toBe("read_file");
  });

  it("micro_compact：多轮读取时，更早轮次的 tool 结果替换为占位符、早期 reasoning 丢弃，最近一轮保留原文", async () => {
    const script: LlmCompletion[] = [
      { text: "", toolCalls: [{ id: "call_a", name: "read_file", argumentsJson: JSON.stringify({ path: "service.ts" }) }], reasoningContent: "思考A1", usage: { inputTokens: 100, outputTokens: 20 }, finishReason: "tool_calls" },
      { text: "", toolCalls: [{ id: "call_b", name: "read_file", argumentsJson: JSON.stringify({ path: "service.test.ts" }) }], reasoningContent: "思考A2", usage: { inputTokens: 150, outputTokens: 25 }, finishReason: "tool_calls" },
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
    const third = calls[2];
    const toolResults = third.messages?.filter((m) => m.role === "tool") ?? [];
    expect(toolResults).toHaveLength(2);
    // 第一轮结果 → 占位符（内容可再生，不逐轮重付）
    expect(toolResults[0].content).toContain("早期读取结果已省略");
    expect(toolResults[0].content.length).toBeLessThan(400);
    // 最近一轮结果 → 原文保留
    expect(toolResults[1].content).toContain("1| ");
    expect(toolResults[1].content.length).toBeGreaterThan(1000);
    // 用占位符独有的短语判定，而不是 "已省略"：本测试的夹具就是本文件，正文里本来就有「已省略」三个字
    expect(toolResults[1].content).not.toContain("以控制上下文");
    // 早期 assistant 的 reasoningContent 丢弃；最近一轮保留（协议要求 tool 轮回传）
    const assistants = third.messages?.filter((m) => m.role === "assistant") ?? [];
    expect(assistants[0].reasoningContent).toBeUndefined();
    expect(assistants[1].reasoningContent).toBe("思考A2");
    // 第二轮请求（只有一轮历史）不受压缩影响
    const second = calls[1];
    const secondTool = second.messages?.find((m) => m.role === "tool");
    expect(secondTool?.content).toContain("1| ");
  });

  it("回复触顶：finishReason=length 时尾附截断声明，半截句子不裸奔", async () => {
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

  it("架构图合成节点：nodeId 未命中但带 scopePaths → 注入「当前作用域」清单（含 L1 职责），未分析路径被丢弃", async () => {
    const { provider, calls } = fakeProvider();
    const index = { repositoryId: "repo_test", files: [{ path: "src/app.ts", lines: 120 }, { path: "src/config.ts", lines: 30 }] } as unknown as RepositoryIndex;
    const search = buildSearchCorpus(index, analysis, new Map([["src/app.ts", "装配应用入口"], ["src/config.ts", "读取并校验配置"]]));
    const result = await mapChat({ repoPath: import.meta.dirname, analysis, nodeId: "depmap:src", scopePaths: ["src/app.ts", "src/config.ts", "README.md"], content: "这个模块依赖谁？", provider, style: 50, search });
    expect(result.scopeDegraded).toBeUndefined(); // 解析成功不留痕，降级率分母才可信
    const user = calls[0].user;
    expect(user).toContain("当前作用域：学习者在架构图选中的模块，含 2 个已分析文件");
    expect(user).toContain("src/app.ts（120 行）：装配应用入口");
    expect(user).not.toContain("README.md"); // 未分析的提示路径不参与交集
    expect(user).not.toContain("不在当前课程树中"); // 作用域已解析成功，不再叠加降级声明
  });

  it("nodeId 未命中且作用域解析为空 → 明示降级为全局视野，不静默，并给出 journal 留痕（scope_paths=上送清单去重数）", async () => {
    const { provider, calls } = fakeProvider();
    const result = await mapChat({ repoPath: import.meta.dirname, analysis, nodeId: "module:src/gone", scopePaths: ["nowhere/x.ts", "nowhere/y.ts", "nowhere/x.ts"], content: "问", provider, style: 50 });
    expect(calls[0].user).toContain("「module:src/gone」不在当前课程树中");
    expect(calls[0].user).toContain("按全局视野作答");
    expect(result.scopeDegraded).toEqual({ nodeId: "module:src/gone", scopePathsCount: 2 });
  });

  it("作用域文件数超上限 → 逐个列前 60 并明示余量与 search_code 出口", async () => {
    const { provider, calls } = fakeProvider();
    const files = Array.from({ length: 65 }, (_, i) => `src/mod/f${i}.ts`);
    const wide = { ...analysis, graph: { ...analysis.graph, imports: Object.fromEntries(files.map((file) => [file, []])) } } as unknown as RepositoryAnalysis;
    await mapChat({ repoPath: import.meta.dirname, analysis: wide, nodeId: "depmap:src/mod", scopePaths: files, content: "问", provider, style: 50 });
    const user = calls[0].user;
    expect(user).toContain("含 65 个已分析文件");
    expect(user).toContain("其余 5 个文件未列出");
  });

  it("最近对话窗口：按时间序注入在代码上下文与问题之间，超长轮次逐轮截断，空内容不生成行", async () => {
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
    expect(user).toContain("长".repeat(400));
    expect(user).not.toContain("长".repeat(401));
    expect(user.indexOf("最近对话")).toBeLessThan(user.indexOf("学习者的问题：第二点再展开讲"));
    expect(user.indexOf("最近对话")).toBeGreaterThan(user.indexOf("项目结构全景"));
    // 空内容轮不生成行：整块只有 学习者/助手 两行
    expect(user.match(/(学习者|助手): /g)?.filter((line) => line === "助手: ").length).toBe(1);
  });

  it("最近对话只取最后 6 轮；无历史时不注入空段", async () => {
    const { provider, calls } = fakeProvider();
    const turns = Array.from({ length: 8 }, (_, i): ScopedChatTurn => ({ role: i % 2 ? "assistant" : "user", content: `轮次${i}` }));
    await mapChat({ repoPath: import.meta.dirname, analysis, content: "问", history: turns, provider, style: 50 });
    expect(calls[0].user).toContain("轮次2");
    expect(calls[0].user).not.toContain("轮次1");
    expect(calls[0].user).not.toContain("轮次0");
    const fresh = fakeProvider();
    await mapChat({ repoPath: import.meta.dirname, analysis, content: "首问", provider: fresh.provider, style: 50 });
    expect(fresh.calls[0].user).not.toContain("最近对话");
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
