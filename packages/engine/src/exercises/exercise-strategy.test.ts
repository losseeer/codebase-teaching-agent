import { describe, expect, it } from "vitest";
import { DEFAULT_EXERCISE_STRATEGY, exerciseStrategyOf } from "./exercise-strategy.js";

const body = (declared: string): string => `# 出题\n\n## 出题策略\n\n当前策略：${declared}\n\n- \`unit\`：锚在真实代码上。\n- \`reference\`：源码只作参考。\n\n## 第三步\n`;
/** 只有 SKILL.md、没有 config.json 的旧副本。 */
const legacy = (declared: string) => (_name: string, file = "SKILL.md"): string | undefined => file === "config.json" ? undefined : body(declared);

describe("出题策略的声明", () => {
  it("读「当前策略」那一行：unit / reference 都认", () => {
    expect(exerciseStrategyOf(legacy("`unit`"))).toBe("unit");
    expect(exerciseStrategyOf(legacy("`reference`"))).toBe("reference");
  });

  it("无配置且无声明时采用默认值；声明取值越界同样回落默认值", () => {
    expect(exerciseStrategyOf(() => undefined)).toBe(DEFAULT_EXERCISE_STRATEGY);
    expect(exerciseStrategyOf((_name: string, file = "SKILL.md") => file === "config.json" ? undefined : "# 出题\n\n## 别的\n\n- `reference`：没写当前策略就不算声明。\n")).toBe("unit");
    expect(exerciseStrategyOf(legacy("`turbo`"))).toBe("unit");
  });

  it("解释两条策略的正文不构成声明：只认「当前策略」那一行", () => {
    const text = "# 出题\n\n## 出题策略\n\n- **`reference`**：源码只作参考。\n- **`unit`**：锚在真实代码上。\n";
    expect(exerciseStrategyOf((_name: string, file = "SKILL.md") => file === "config.json" ? undefined : text)).toBe("unit");
  });
});

describe("出题策略的配置", () => {
  const config = (value: unknown): string => JSON.stringify({ version: 1, exerciseStrategy: value });

  it("config.json 优先于 SKILL.md 的旧声明", () => {
    const bodyOf = (_name: string, file = "SKILL.md"): string | undefined =>
      file === "config.json" ? config("reference") : body("`unit`");
    expect(exerciseStrategyOf(bodyOf)).toBe("reference");
  });

  it("config.json 非法时抛错，不回落默认值", () => {
    const withConfig = (raw: string) => (_name: string, file = "SKILL.md"): string | undefined =>
      file === "config.json" ? raw : undefined;
    expect(() => exerciseStrategyOf(withConfig("{"))).toThrow(/不是合法 JSON/);
    expect(() => exerciseStrategyOf(withConfig(config("turbo")))).toThrow(/必须为 "unit" 或 "reference"/);
  });

  it("没有 config.json 时按旧声明取值", () => {
    expect(exerciseStrategyOf((_name, file = "SKILL.md") => file === "config.json" ? undefined : body("`reference`"))).toBe("reference");
  });
});
