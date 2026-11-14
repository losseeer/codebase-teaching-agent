import { describe, expect, it } from "vitest";

import { exerciseQaSystemPrompt, overviewSystemPrompt, teachingSystemPrompt } from "./prompts.js";

const policy = { pedagogy: "socratic" as const, depth: "macro" as const, constraints: [] };

describe("对话提示词的引用规范", () => {
  it("三个工作区都要求先核实路径、写不出完整路径就说明", () => {
    const systems = [
      teachingSystemPrompt({ policy }),
      overviewSystemPrompt({ searchAvailable: true }),
      exerciseQaSystemPrompt(),
      overviewSystemPrompt({ searchAvailable: false })
    ];
    for (const system of systems) {
      expect(system).toContain("必须先用可用工具核实它在仓库内的完整路径");
      expect(system).toContain("具体位置未核实");
      expect(system).toContain("不要写省略模块前缀的相对路径");
    }
  });
});

describe("用户画像注入", () => {
  it("有画像时三个场景都带上；空画像不出现标题", () => {
    const profile = "## 表达偏好\n严谨、具体、结构清晰。";
    const policy = { pedagogy: "socratic" as const, depth: "macro" as const, constraints: [] };
    for (const system of [
      teachingSystemPrompt({ policy, profile }),
      overviewSystemPrompt({ searchAvailable: true, profile }),
      exerciseQaSystemPrompt({ profile })
    ]) {
      expect(system).toContain("【用户画像】");
      expect(system).toContain("严谨、具体、结构清晰");
    }
    expect(teachingSystemPrompt({ policy })).not.toContain("【用户画像】");
    expect(exerciseQaSystemPrompt()).not.toContain("【用户画像】");
  });
});
