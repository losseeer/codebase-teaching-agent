import { afterEach, describe, expect, it } from "vitest";
import type { TeachingPolicy, TutorMessage } from "@codebase-tutor/domain";

import { HISTORY_KEEP_EARLIEST_MESSAGES, HISTORY_KEEP_RECENT_MESSAGES } from "../llm/conversation.js";
import type { ScopeRef } from "../source/scope-ref.js";
import { assembleContext } from "./context-teaching.js";

/**
  对话历史进教学上下文的两档：窗口还宽就整段原文（不逐行截断），
  装不下本轮分给它的空间就折——最近几条 + 最早几条 + 一句占位（口径在 `llm/conversation.ts`）。
*/

const scope: ScopeRef = { kind: "file", path: "src/main.ts", ref: "file:src/main.ts" };
const policy = { constraints: ["先复述目标"] } as unknown as TeachingPolicy;
const msg = (role: "user" | "assistant", content: string, i: number): TutorMessage => ({ id: `m${i}`, role, content } as TutorMessage);

const ENV_KEY = "TUTOR_CONTEXT_WINDOW_TOKENS";
const previous = process.env[ENV_KEY];
afterEach(() => {
  if (previous === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previous;
});

describe("assembleContext 的对话历史", () => {
  it("窗口够宽时整段原文进上下文：长答不再被截，空内容轮不出行", () => {
    const history = [
      msg("user", "这个模块的分层有哪些？", 1),
      msg("assistant", "导师长答A".repeat(60), 2),
      msg("user", "   \n  ", 3)
    ];
    const context = assembleContext({ scope, policy, history, query: "第二点再展开讲" });
    expect(context).toContain("导师长答A".repeat(60));
    expect(context).toContain("学习者: 这个模块的分层有哪些？");
    expect(context).toContain("导师: 导师长答A");
    expect(context.match(/导师: /g)).toHaveLength(1);
    expect(context).not.toContain("已折叠");
  });

  it("窗口配小到装不下时折叠：留最近几条与最早几条，中间换成占位", () => {
    // 32000 token = 128000 字符：教学上限 3%（3840）里先给摘录留 2%（2560），对话只剩约 1000 字符
    process.env[ENV_KEY] = "32000";
    const history = [
      msg("user", "开场问题：这个仓怎么分层", 1),
      msg("assistant", "开场答：按主干、设施、外部三档", 2),
      ...Array.from({ length: 12 }, (_, i) => msg(i % 2 ? "assistant" : "user", `中间轮次${i}${"聊".repeat(140)}`, 10 + i)),
      msg("user", "最近的问题", 90),
      msg("assistant", "最近的回答", 91)
    ];
    const context = assembleContext({ scope, policy, history, query: "再展开讲讲" });
    expect(context).toContain("开场问题：这个仓怎么分层");
    expect(context).toContain("最近的回答");
    const middleCount = history.length - HISTORY_KEEP_EARLIEST_MESSAGES - HISTORY_KEEP_RECENT_MESSAGES;
    expect(context).toContain(`中间 ${middleCount} 条对话已折叠`);
    expect(context).not.toContain("中间轮次6");
    expect(middleCount).toBeGreaterThan(0);
  });

  it("本轮提问引用了折叠段里的说法时，那一条原文被找回来贴在占位下面", () => {
    process.env[ENV_KEY] = "32000";
    const history = [
      msg("user", "开场", 1),
      msg("assistant", "开场答：分层三档", 2),
      msg("user", `闲聊一${"聊".repeat(140)}`, 3),
      msg("assistant", "装配清单里有一处 蓝绿发布锚点：它落在 registry.ts。", 4),
      ...Array.from({ length: 6 }, (_, i) => msg(i % 2 ? "assistant" : "user", `闲聊${2 + i}${"聊".repeat(140)}`, 10 + i)),
      msg("user", "最近的问题", 90)
    ];
    const plain = assembleContext({ scope, policy, history, query: "整体再说一遍" });
    expect(plain).toContain("已折叠");
    expect(plain).not.toContain("蓝绿发布锚点");
    const citing = assembleContext({ scope, policy, history, query: "蓝绿发布锚点在哪一行？" });
    expect(citing).toContain("蓝绿发布锚点：它落在 registry.ts");
    expect(citing).toContain("与本轮提问最相关的 1 条");
  });
});
