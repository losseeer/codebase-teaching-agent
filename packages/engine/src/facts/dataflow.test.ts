import { beforeAll, describe, expect, it } from "vitest";
import { languageCapabilitiesOf, type DataflowFunctionFact, type DataflowVariable } from "@codebase-tutor/shared";
import { extractSymbolsFromAst, loadSymbolParser } from "../depgraph/parser.js";
import { analyzeFile } from "./index.js";

/**
  断言盯住「把到不了的定义算成能到」：只按「同一函数里赋过值」报，
  分支与循环里就会满是假到达，而这份产物用来说明「这个值从哪来」。
*/

beforeAll(async () => {
  await loadSymbolParser();
});

function flow(code: string[], path = "sample.ts", name = "f"): DataflowFunctionFact {
  const source = code.join("\n");
  const symbols = extractSymbolsFromAst(path, source) ?? [];
  const fact = analyzeFile(path, source, symbols, languageCapabilitiesOf(path).language);
  const target = fact.dataflow.functions.find((item) => item.name === name);
  if (!target) throw new Error(`没算出 ${name} 的数据流：${fact.dataflow.functions.map((item) => item.name).join(" / ") || "无"}；skipped=${JSON.stringify(fact.dataflow.skipped ?? [])}`);
  expect(target.symbolId, "数据流与图必须挂在同一个函数键上").toBe(fact.cfg.functions.find((item) => item.name === name)?.symbolId);
  return target;
}

const variable = (fact: DataflowFunctionFact, name: string): DataflowVariable => {
  const found = fact.variables.find((item) => item.name === name);
  if (!found) throw new Error(`没有变量 ${name}，实际有：${fact.variables.map((item) => item.name).join(" / ")}`);
  return found;
};

describe("到达定义", () => {
  it("分支里改过的值：两条定义都能到达后面的使用", () => {
    const fact = flow([
      "function f(a: number) {",
      "  let x = 1;",
      "  if (a > 0) { x = 2; }",
      "  return x;",
      "}"
    ]);
    const x = variable(fact, "x");
    expect(x.defs.map((def) => def.line)).toEqual([2, 3]);
    expect(x.defs.map((def) => def.role)).toEqual(["init", "assign"]);
    expect(x.uses.find((use) => use.line === 4)?.reaches, "没进分支时 x 还是 2 行那个值").toEqual([2, 3]);
  });

  it("读在写之前：不编一条到达关系，落到 unresolved", () => {
    const fact = flow([
      "function f() {",
      "  console.log(y);",
      "  const y = 1;",
      "  return y;",
      "}"
    ]);
    const y = variable(fact, "y");
    expect(y.uses.find((use) => use.line === 2)?.reaches, "第 2 行那次读没有任何可达定义").toEqual([]);
    expect(fact.unresolved?.some((item) => item.name === "y" && item.line === 2)).toBe(true);
    expect(y.uses.find((use) => use.line === 4)?.reaches).toEqual([3]);
  });

  it("同一块里两写夹一读：写在读之前的那次要报到达，不能被块末的最后一次定义挤掉", () => {
    const fact = flow([
      "function f() {",
      "  let x = 1;",
      "  use(x);",
      "  x = 2;",
      "}"
    ]);
    const x = variable(fact, "x");
    expect(x.uses.find((use) => use.line === 3)?.reaches, "第 3 行的读到达第 2 行的写").toEqual([2]);
    expect(x.uses.find((use) => use.line === 3)?.reaches, "第 4 行的后写不该混进来").not.toContain(4);
  });

  it("循环里自增：回边让「上一轮的值」也到达本轮的读", () => {
    const fact = flow([
      "function f(n: number) {",
      "  let total = 0;",
      "  for (let i = 0; i < n; i++) { total = total + i; }",
      "  return total;",
      "}"
    ]);
    const total = variable(fact, "total");
    const inner = total.uses.find((use) => use.line === 3)!;
    expect(inner.reaches, "循环体内那次读，可能来自初始化，也可能来自上一轮的赋值").toEqual([2, 3]);
    expect(variable(fact, "i").defs.map((def) => def.role)).toContain("init");
  });

  it("参数是定义：函数体里的读要能到达它", () => {
    const fact = flow([
      "function f(seed: number) {",
      "  return seed + seed;",
      "}"
    ]);
    const seed = variable(fact, "seed");
    expect(seed.defs).toHaveLength(1);
    expect(seed.defs[0].role).toBe("param");
    expect(seed.uses).toHaveLength(2);
    expect(seed.uses.every((use) => use.reaches.length === 1)).toBe(true);
  });

  it("成员访问的属性名不算变量使用，对象名算", () => {
    const fact = flow([
      "function f(cfg: { host: string }) {",
      "  return cfg.host;",
      "}"
    ]);
    expect(fact.variables.map((item) => item.name)).toContain("cfg");
    expect(fact.variables.map((item) => item.name), "host 是对字段名的引用，不是对变量的使用").not.toContain("host");
  });

  it("分支内只在一侧定义的值，另一侧的读不该到达它", () => {
    const fact = flow([
      "function f(a: number) {",
      "  if (a > 0) { const b = 1; return b; }",
      "  return a;",
      "}"
    ]);
    const b = variable(fact, "b");
    expect(b.uses.every((use) => use.reaches.length === 1)).toBe(true);
    expect(b.defs[0].block, "b 的定义要落在分支块里，而不是函数入口块").not.toBe(0);
  });

  it("Python 与 Java 的赋值形状共用同一套判据", () => {
    const python = flow([
      "def f(a):",
      "    total = 0",
      "    for i in range(a):",
      "        total = total + i",
      "    return total"
    ], "sample.py", "f");
    expect(variable(python, "total").defs.map((def) => def.line)).toEqual([2, 4]);
    expect(variable(python, "total").uses.find((use) => use.line === 4)?.reaches).toEqual([2, 4]);

    const java = flow([
      "class C {",
      "  int f(int n) {",
      "    int total = 0;",
      "    for (int i = 0; i < n; i++) { total = total + i; }",
      "    return total;",
      "  }",
      "}"
    ], "C.java", "f");
    expect(variable(java, "total").defs.map((def) => def.line)).toEqual([3, 4]);
    expect(variable(java, "total").uses.find((use) => use.line === 5)?.reaches).toEqual([3, 4]);
  });
});
