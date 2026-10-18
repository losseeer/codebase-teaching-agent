import { describe, expect, it } from "vitest";
import { applyDotEnv, parseDotEnv } from "./dotenv.js";

describe("parseDotEnv", () => {
  it("解析常规键值对并跳过注释与空行", () => {
    const parsed = parseDotEnv([
      "# 顶部注释",
      "",
      "TUTOR_LLM_PROVIDER=openai",
      "  TUTOR_LLM_MODEL = gpt-4o-mini  ",
      "   # 行注释也要跳过"
    ].join("\n"));
    expect(parsed).toEqual({ TUTOR_LLM_PROVIDER: "openai", TUTOR_LLM_MODEL: "gpt-4o-mini" });
  });

  /**
    模板文件里 `KEY=   # 这一项留空会怎样` 是主要写法：等号后只剩一段说明。
    不特判的话整段中文注释会被当成配置值读进去——`.env.example` 抄成 `.env` 就中招，
    而且读起来像「配了但没用」，比读不到更难查。
    */
  it("空值加行内注释 = 空值，注释不进值里", () => {
    const parsed = parseDotEnv([
      "TUTOR_LLM_PROVIDER=              # openai | anthropic | ollama；留空 = 不启用模型",
      "TUTOR_LLM_TIMEOUT_MS=12000       # 单次请求超时",
      "TUTOR_EMBED_API_KEY=\t# 与对话用的 key 分开配"
    ].join("\n"));
    expect(parsed.TUTOR_LLM_PROVIDER).toBe("");
    expect(parsed.TUTOR_LLM_TIMEOUT_MS).toBe("12000");
    expect(parsed.TUTOR_EMBED_API_KEY).toBe("");
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
