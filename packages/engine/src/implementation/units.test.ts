import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SymbolInfo } from "@codebase-tutor/shared";
import { buildImplementationUnits } from "./units.js";

function symbol(path: string, name: string, line = 1, endLine = 3): SymbolInfo {
  return { id: `symbol:${path}:${name}:${line}`, name, kind: "function", path, line, endLine, parameters: [], language: "typescript" };
}

describe("buildImplementationUnits", () => {
  it("读不出来的文件只让那一个符号缺席，不掀掉整次导入", () => {
    const dir = mkdtempSync(join(tmpdir(), "tutor-units-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/keep.ts"), "export function kept() {\n  return 1;\n}\n");
      // 索引之后文件被删 / 被换成特殊节点：与扫描层 §37.3 同一条口径——缺席可以，掀桌不行
      const units = buildImplementationUnits(dir, [symbol("src/keep.ts", "kept"), symbol("src/gone.ts", "vanished"), symbol("src", "isDirectory")]);
      expect(units.map((unit) => unit.symbol.name)).toEqual(["kept"]);
      expect(units[0].output, "正文取的是定义区间里的 return 表达式").toBe("返回 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
