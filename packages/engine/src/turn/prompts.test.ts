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
