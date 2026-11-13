import { describe, expect, it } from "vitest";

import { overviewSystemPrompt } from "./prompts.js";

describe("架构全景对话的核实约束", () => {
  it("有无检索工具都要求先核实路径、核实不了就明说", () => {
    for (const searchAvailable of [true, false]) {
      const system = overviewSystemPrompt({ searchAvailable });
      expect(system).toContain("必须先用可用工具核实它在仓库内的完整路径");
      expect(system).toContain("具体位置未核实");
      expect(system).toContain("不要写省略模块前缀的相对路径");
    }
  });
});
