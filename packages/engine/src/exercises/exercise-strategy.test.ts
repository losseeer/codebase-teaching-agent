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

  it("技能未安装时采用默认值；技能存在但既无配置也无有效声明时抛错", () => {
    expect(exerciseStrategyOf(() => undefined)).toBe(DEFAULT_EXERCISE_STRATEGY);
    const noDeclaration = (_name: string, file = "SKILL.md"): string | undefined =>
      file === "config.json" ? undefined : "# 出题\n\n## 别的\n\n- `reference`：没写当前策略就不算声明。\n";
    expect(() => exerciseStrategyOf(noDeclaration)).toThrow(/缺少 config.json/);
    expect(() => exerciseStrategyOf(legacy("`turbo`"))).toThrow(/缺少 config.json/);
  });

  it("解释两条策略的正文不构成声明：无有效声明时报错", () => {
    const text = "# 出题\n\n## 出题策略\n\n- **`reference`**：源码只作参考。\n- **`unit`**：锚在真实代码上。\n";
    expect(() => exerciseStrategyOf((_name: string, file = "SKILL.md") => file === "config.json" ? undefined : text)).toThrow(/缺少 config.json/);
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
