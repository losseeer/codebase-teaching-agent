import { afterEach, describe, expect, it } from "vitest";
import {
  HISTORY_COMPACT_AT_RATIO,
  HISTORY_KEEP_EARLIEST_MESSAGES,
  HISTORY_KEEP_RECENT_MESSAGES,
  conversationCharacters,
  renderConversation
} from "./conversation.js";
import { CHARS_PER_TOKEN, contextWindowTokens } from "./context-window.js";

const ENV_KEY = "TUTOR_CONTEXT_WINDOW_TOKENS";
const previous = process.env[ENV_KEY];
/** 10000 token 窗口 = 40000 字符。 */
const WINDOW = "10000";
afterEach(() => {
  if (previous === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previous;
});

const turn = (role: "user" | "assistant", content: string) => ({ role, content });
const filler = (label: string) => `${label}${"聊".repeat(140)}`;
/** 十条、总量在预算内的历史。 */
const modest = Array.from({ length: 10 }, (_, index) => turn(index % 2 ? "assistant" : "user", filler(`甲${index}`)));
/** 同样条数、每条更长的历史。 */
const verbose = Array.from({ length: 10 }, (_, index) => turn(index % 2 ? "assistant" : "user", filler(`乙${index}${"细".repeat(200)}`)));

describe("renderConversation", () => {
  it("没有可渲染的历史就交空串，不注入空段", () => {
    process.env[ENV_KEY] = WINDOW;
    expect(renderConversation({ turns: [], query: "问", usedCharacters: 0 })).toEqual({ text: "", foldedMessages: 0, recalledMessages: 0 });
    expect(renderConversation({ turns: [turn("user", "   \n ")], query: "问", usedCharacters: 0 }).text).toBe("");
  });

  it("窗口还宽、空间也够：整段原文按时间序留着", () => {
    process.env[ENV_KEY] = WINDOW;
    const block = renderConversation({ turns: [turn("user", "首问"), turn("assistant", "首答"), turn("user", "追问")], query: "追问的追问", usedCharacters: 100 });
    expect(block.text).toContain("学习者: 首问");
    expect(block.text).toContain("助手: 首答");
    expect(block.foldedMessages).toBe(0);
    expect(block.text).not.toContain("已折叠");
  });

  it("条数不超过「最早 + 最近」时不折：折了也不会更少", () => {
    process.env[ENV_KEY] = WINDOW;
    const exactly = Array.from({ length: HISTORY_KEEP_EARLIEST_MESSAGES + HISTORY_KEEP_RECENT_MESSAGES }, (_, index) => turn("user", filler(`丙${index}`)));
    const block = renderConversation({ turns: exactly, query: "问", usedCharacters: 40_000 });
    expect(block.foldedMessages).toBe(0);
    expect(block.text).toContain("丙0");
    expect(block.text).toContain(`丙${exactly.length - 1}`);
  });

  it("占到窗口的 m 倍比例就折：留最早几条与最近几条，中间换成一句占位", () => {
    process.env[ENV_KEY] = WINDOW;
    const threshold = contextWindowTokens() * CHARS_PER_TOKEN * HISTORY_COMPACT_AT_RATIO;
    expect(conversationCharacters(modest), "夹具本身要留在预算内，才能只靠窗口占用触发").toBeLessThan(2000);
    const block = renderConversation({ turns: modest, query: "整体再说一遍", usedCharacters: threshold - conversationCharacters(modest) + 1 });
    expect(block.text).toContain("已折叠");
    expect(block.text).toContain(`中间 ${modest.length - HISTORY_KEEP_EARLIEST_MESSAGES - HISTORY_KEEP_RECENT_MESSAGES} 条对话已折叠`);
    expect(block.text, "开场的目标陈述要留着").toContain("甲0");
    expect(block.text, "最近一条必须留着").toContain(`甲${modest.length - 1}`);
    expect(block.text).not.toContain("甲2");
    expect(block.foldedMessages).toBe(modest.length - HISTORY_KEEP_EARLIEST_MESSAGES - HISTORY_KEEP_RECENT_MESSAGES);
    expect(block.recalledMessages).toBe(0);
  });

  it("窗口没告急但本轮装不下这段历史，同样折（长线程不许把源码摘录挤光）", () => {
    process.env[ENV_KEY] = WINDOW;
    const block = renderConversation({ turns: verbose, query: "整体再说一遍", usedCharacters: 0 });
    expect(block.text).toContain("已折叠");
    expect(block.text).not.toContain("乙2");
    expect(block.text).toContain("乙9");
  });

  it("本轮提问引用了折叠段里的说法：按词法把那条原文找回来，找回的不算折掉", () => {
    process.env[ENV_KEY] = WINDOW;
    const turns = [
      turn("user", "开场：这个仓怎么分层"),
      turn("assistant", "开场答：按主干、设施、外部三档。"),
      turn("user", filler("中段一问")),
      turn("assistant", "装配清单里有一处 蓝绿发布锚点：它落在 registry.ts。"),
      turn("user", filler("中段二问")),
      turn("assistant", filler("中段二答")),
      turn("user", filler("中段三问")),
      turn("assistant", filler("中段三答")),
      turn("user", filler("中段四问")),
      turn("assistant", filler("中段四答")),
      turn("user", "最近的问题")
    ];
    // 折叠段 = 最早与最近保留窗口之外的部分
    const middleCount = turns.length - HISTORY_KEEP_EARLIEST_MESSAGES - HISTORY_KEEP_RECENT_MESSAGES;
    const usedCharacters = contextWindowTokens() * CHARS_PER_TOKEN * HISTORY_COMPACT_AT_RATIO + 1;
    const cited = renderConversation({ turns, query: "蓝绿发布锚点在哪一行？", usedCharacters });
    expect(cited.text).toContain("蓝绿发布锚点：它落在 registry.ts");
    expect(cited.text).toContain("与本轮提问最相关的 1 条");
    expect(cited.recalledMessages).toBe(1);
    expect(cited.foldedMessages).toBe(middleCount - 1);
    const plain = renderConversation({ turns, query: "整体再说一遍", usedCharacters });
    expect(plain.recalledMessages, "没引用就别硬塞，找回的内容也是 token").toBe(0);
    expect(plain.text).not.toContain("蓝绿发布锚点");
  });

  it("找回条数封顶：折叠段里多处相关时只带最相关的几条回来", () => {
    process.env[ENV_KEY] = WINDOW;
    /* 相关行数必须少于整段行数。 */
    const middle = Array.from({ length: 10 }, (_, index) =>
      index % 5 < 3 ? turn("assistant", `第${index}处 蓝绿发布锚点 的说明${"注".repeat(30)}`) : turn("assistant", filler(`中${index}`)));
    const turns = [
      turn("user", "开场"),
      turn("assistant", "开场答"),
      ...middle,
      ...Array.from({ length: 6 }, (_, index) => turn(index % 2 ? "assistant" : "user", filler(`末${index}`)))
    ];
    expect(turns.length - HISTORY_KEEP_EARLIEST_MESSAGES - HISTORY_KEEP_RECENT_MESSAGES, "十行落在折叠段里，才谈得上封顶").toBe(10);
    const block = renderConversation({ turns, query: "蓝绿发布锚点的说明在哪", usedCharacters: contextWindowTokens() * CHARS_PER_TOKEN * HISTORY_COMPACT_AT_RATIO + 1 });
    expect(block.recalledMessages).toBe(3);
    expect(block.text).toContain("最相关的 3 条");
  });

  it("连最早几条都装不下时从最可有可无的那端撤起，最近一条与折叠说明不被撤走", () => {
    process.env[ENV_KEY] = WINDOW;
    const block = renderConversation({ turns: modest, query: "问", usedCharacters: 0, budgetCharacters: 1150 });
    expect(block.text).toContain("已折叠");
    expect(block.text, "装不下时先撤最早那几条").not.toContain("甲0");
    expect(block.text).toContain("甲1");
    expect(block.text, "刚问过的那条永远留着").toContain(`甲${modest.length - 1}`);
    expect(block.text).not.toContain("被切了尾的");
  });

  it("标签跟着作用域换：代码问答里对方是导师", () => {
    process.env[ENV_KEY] = WINDOW;
    const block = renderConversation({ turns: [turn("user", "首问"), turn("assistant", "首答")], query: "追问", usedCharacters: 0, labels: { user: "学习者", assistant: "导师" } });
    expect(block.text).toContain("导师: 首答");
    expect(block.text).not.toContain("助手: ");
  });
});
