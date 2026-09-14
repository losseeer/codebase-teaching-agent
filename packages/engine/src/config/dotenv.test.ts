import { describe, expect, it } from "vitest";
import { applyDotEnv, parseDotEnv } from "./dotenv.js";

describe("parseDotEnv", () => {
  it("解析常规键值对并跳过注释与空行", () => {
    const parsed = parseDotEnv([
      "# 顶部注释",
      "",
      "TUTOR_TEACHING_PROVIDER=openai",
      "  TUTOR_TEACHING_MODEL = gpt-4o-mini  ",
      "   # 行注释也要跳过"
    ].join("\n"));
    expect(parsed).toEqual({ TUTOR_TEACHING_PROVIDER: "openai", TUTOR_TEACHING_MODEL: "gpt-4o-mini" });
  });

  it("支持 export 前缀、引号包裹与行内注释", () => {
    const parsed = parseDotEnv([
      "export FOO=bar # 行内注释",
      "QUOTED=\"hello world\"",
      "SINGLE='it''s fine'".replace("''", "'"),
      "URL=https://api.example.com/v1#fragment", // URL 的 # 不是注释
      "EMPTY="
    ].join("\n"));
    expect(parsed.FOO).toBe("bar");
    expect(parsed.QUOTED).toBe("hello world");
    expect(parsed.SINGLE).toBe("it's fine");
    expect(parsed.URL).toBe("https://api.example.com/v1#fragment");
    expect(parsed.EMPTY).toBe("");
  });

  it("忽略非法行（无等号、非法键名）", () => {
    expect(parseDotEnv("NOT_A_PAIR\n1BAD=x\n=none\nOK=yes")).toEqual({ OK: "yes" });
  });
});

describe("applyDotEnv", () => {
  it("只填缺失键，不覆盖已有环境变量", () => {
    process.env.TUTOR_DOTENV_TEST_EXISTING = "keep";
    const injected = applyDotEnv({ TUTOR_DOTENV_TEST_EXISTING: "skip", TUTOR_DOTENV_TEST_NEW: "injected" });
    expect(injected).toEqual(["TUTOR_DOTENV_TEST_NEW"]);
    expect(process.env.TUTOR_DOTENV_TEST_EXISTING).toBe("keep");
    expect(process.env.TUTOR_DOTENV_TEST_NEW).toBe("injected");
    delete process.env.TUTOR_DOTENV_TEST_EXISTING;
    delete process.env.TUTOR_DOTENV_TEST_NEW;
  });
});
