import { afterEach, describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, CONTEXT_SHARE, DEFAULT_CONTEXT_WINDOW_TOKENS, contextShare, contextShareLines, contextWindowTokens } from "./context-window.js";

const ENV_KEY = "TUTOR_CONTEXT_WINDOW_TOKENS";
const previous = process.env[ENV_KEY];
afterEach(() => {
  if (previous === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previous;
});

describe("上下文窗口（体积上限的唯一真源）", () => {
  it("未配置、非数字、窗口太小都回落到默认值", () => {
    delete process.env[ENV_KEY];
    expect(contextWindowTokens()).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    for (const raw of ["", "abc", "0", "-1", "4000"]) {
      process.env[ENV_KEY] = raw;
      expect(contextWindowTokens(), `「${raw}」不是一张能用的窗口，按默认办事`).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    }
  });

  it("每次调用现读配置：改完不必重启", () => {
    process.env[ENV_KEY] = "32000";
    expect(contextWindowTokens()).toBe(32000);
    process.env[ENV_KEY] = "64000";
    expect(contextWindowTokens()).toBe(64000);
  });

  it("预算按窗口线性派生，窗口翻倍预算也翻倍", () => {
    process.env[ENV_KEY] = "100000";
    const small = contextShare(CONTEXT_SHARE.fileRead);
    process.env[ENV_KEY] = "200000";
    expect(contextShare(CONTEXT_SHARE.fileRead)).toBe(small * 2);
  });

  it("窗口配多小就按多小办事：派生预算不给地板", () => {
    process.env[ENV_KEY] = "8000";
    expect(contextShare(CONTEXT_SHARE.factsQuery)).toBe(Math.floor(8000 * CHARS_PER_TOKEN * CONTEXT_SHARE.factsQuery));
  });

  it("行数预算按平均行长折算", () => {
    process.env[ENV_KEY] = "100000";
    expect(contextShareLines(0.1, 40)).toBe(Math.floor(contextShare(0.1) / 40));
  });

  it("份额都是真分数且总量远小于整窗：剩下的留给输出与后续轮次累积", () => {
    const shares = Object.values(CONTEXT_SHARE);
    expect(shares.length).toBe(Object.keys(CONTEXT_SHARE).length);
    for (const [name, share] of Object.entries(CONTEXT_SHARE)) {
      expect(share, name).toBeGreaterThan(0);
      expect(share, name).toBeLessThan(1);
    }
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThan(0.5);
  });

  it("任何一项份额都不许超过整窗的字符数", () => {
    process.env[ENV_KEY] = "8000";
    const windowChars = 8000 * CHARS_PER_TOKEN;
    for (const [name, share] of Object.entries(CONTEXT_SHARE)) {
      expect(contextShare(share), name).toBeLessThanOrEqual(windowChars);
    }
  });
});
