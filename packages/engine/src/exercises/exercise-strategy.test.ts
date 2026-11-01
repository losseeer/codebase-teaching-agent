import { describe, expect, it } from "vitest";
import { DEFAULT_EXERCISE_STRATEGY, exerciseStrategyOf } from "./exercise-strategy.js";

const body = (declared: string): string => `# 出题\n\n## 出题策略\n\n当前策略：${declared}\n\n- \`unit\`：锚在真实代码上。\n- \`reference\`：源码只作参考。\n\n## 第三步\n`;

describe("出题策略的声明", () => {
  it("读「当前策略」那一行：unit / reference 都认", () => {
    expect(exerciseStrategyOf(() => body("`unit`"))).toBe("unit");
    expect(exerciseStrategyOf(() => body("`reference`"))).toBe("reference");
  });

  it("技能没装、没有这一节、写得认不出，都按 unit", () => {
    expect(exerciseStrategyOf(() => undefined)).toBe(DEFAULT_EXERCISE_STRATEGY);
    expect(exerciseStrategyOf(() => "# 出题\n\n## 别的\n\n- `reference`：没写当前策略就不算声明。\n")).toBe("unit");
    expect(exerciseStrategyOf(() => body("`turbo`"))).toBe("unit");
  });

  it("解释两条策略的正文不构成声明：只认「当前策略」那一行", () => {
    const text = "# 出题\n\n## 出题策略\n\n- **`reference`**：源码只作参考。\n- **`unit`**：锚在真实代码上。\n";
    expect(exerciseStrategyOf(() => text)).toBe("unit");
  });
});
