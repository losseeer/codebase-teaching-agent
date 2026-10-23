import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph } from "./graph.js";
import { impactRadius } from "./impact-radius.js";
import { loadSymbolParser } from "./parser.js";

/** 临时目录造小仓库：新语言的解析规则用独立夹具，不进 frozen fixture 的共享快照。 */
async function withRepo<T>(name: string, fileMap: Record<string, string>, run: (dir: string) => T): Promise<T> {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), `tutor-${name}-`));
  try {
    for (const [path, content] of Object.entries(fileMap)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("多语言依赖边与入口（Go/Rust/C#/C++）", () => {
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it("Go：import 按 go.mod 模块前缀落到包目录内全部文件；func main 是权威入口", () =>
    withRepo("go", {
      "go.mod": "module example.com/shop\n\ngo 1.21\n",
      "main.go": "package main\n\nimport (\n\t\"fmt\"\n\t\"example.com/shop/util\"\n)\n\nfunc main() {\n\tfmt.Println(util.Sum(1, 2))\n}\n",
      "util/sum.go": "package util\n\nfunc Sum(a int, b int) int {\n\treturn a + b\n}\n",
      "util/sum_test.go": "package util\n\nfunc TestSum(t int) {\n\tSum(1, 2)\n}\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      // 第三方/stdlib（fmt）丢弃；包目录命中全部非测试文件（_test.go 不入落点）
      expect(graph.imports.get("main.go")).toEqual(["util/sum.go"]);
      expect(graph.entrypoints).toContainEqual({ path: "main.go", line: 8, label: "Go 主函数" });
      const call = graph.calls.find((edge) => edge.callerPath === "main.go" && edge.calleePath === "util/sum.go");
      expect(call?.calleeSymbol).toContain("Sum");
    }));

  it("Rust：mod 声明与 use crate:: 都落点；fn main 是权威入口", () =>
    withRepo("rust", {
      "src/main.rs": "mod util;\n\nuse crate::util::sum;\n\nfn main() {\n\tlet n = sum(1, 2);\n}\n",
      "src/util.rs": "pub fn sum(a: i32, b: i32) -> i32 {\n\ta + b\n}\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      // mod:util 与 use:crate::util::sum（sum 是条目，逐级上溯）都指向 src/util.rs，合并一条
      expect(graph.imports.get("src/main.rs")).toEqual(["src/util.rs"]);
      expect(graph.entrypoints).toContainEqual({ path: "src/main.rs", line: 5, label: "Rust 主函数" });
    }));

  it("C#：using 按命名空间索引落点；static void Main 是权威入口", () =>
    withRepo("csharp", {
      "Program.cs": "using Shop.Core;\n\nnamespace Shop.App\n{\n\tpublic static class Program\n\t{\n\t\tpublic static void Main()\n\t\t{\n\t\t\tCalculator.Sum(1, 2);\n\t\t}\n\t}\n}\n",
      "Core/Calculator.cs": "namespace Shop.Core\n{\n\tpublic static class Calculator\n\t{\n\t\tpublic static int Sum(int a, int b) => a + b;\n\t}\n}\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      expect(graph.imports.get("Program.cs")).toEqual(["Core/Calculator.cs"]);
      expect(graph.entrypoints).toContainEqual({ path: "Program.cs", line: 7, label: "C# 主函数" });
    }));

  it("C/C++：引号 include 先相对后全仓后缀；尖括号系统头不入图；int main 是权威入口", () =>
    withRepo("cpp", {
      "src/app.cpp": "#include \"calc.h\"\n#include <vector>\n\nint main() {\n\treturn calc(1, 2);\n}\n",
      "src/calc.h": "#pragma once\n\nint calc(int a, int b);\n",
      "src/calc.cpp": "#include \"calc.h\"\n\nint calc(int a, int b) {\n\treturn a + b;\n}\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      expect(graph.imports.get("src/app.cpp")).toEqual(["src/calc.h"]);
      expect(graph.imports.get("src/calc.cpp")).toEqual(["src/calc.h"]);
      expect(graph.entrypoints).toContainEqual({ path: "src/app.cpp", line: 4, label: "C/C++ 主函数" });
    }));

});

describe("整仓自环与「每个文件一个源码根」", () => {
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it("自环不落依赖边：Go 导自己的包目录、Rust 的 crate 自引用、Python 的绝对自导入", async () =>
    await withRepo("no-self-loop", {
      "go.mod": "module example.com/shop\n\ngo 1.21\n",
      "util/sum.go": "package util\n\nimport \"example.com/shop/util\"\n\nfunc Sum() int {\n\treturn Helper()\n}\n\nfunc Helper() int {\n\treturn 1\n}\n",
      "src/a.rs": "use crate::a::helper;\n\npub fn run() -> i32 {\n\thelper()\n}\n",
      "app/store.py": "import app.store\n\ndef load():\n    return app.store\n",
      "app/__init__.py": ""
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      expect([...graph.imports.entries()].filter(([from, targets]) => targets.includes(from)), "图里不许有 X→X").toEqual([]);
      expect(graph.imports.get("util/sum.go"), "go 的包目录落点含自己").toEqual([]);
      expect(graph.imports.get("src/a.rs"), "use crate::<本模块>::X 指回自己").toEqual([]);
      expect(graph.imports.get("app/store.py"), "import app.store 写在 store.py 里").toEqual([]);
      // 影响范围也不许把「改它影响它自己」当证据
      expect(impactRadius(graph, ["util/sum.go"]).edges).toEqual([]);
    }));

});
