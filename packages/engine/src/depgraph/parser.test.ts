import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildDependencyGraph } from "./graph.js";
import { indexRepository } from "../indexer/indexer.js";
import { extractSymbolsFromAst, loadSymbolParser, parseBackendStatus, resetSymbolParserForTest } from "./parser.js";

/**
  语法树符号抽取：这里验证的是「逐行文本匹配做不到的事」——
  类方法、接口/类型别名、装饰器包裹的函数、精确的最后一行。
  最后两例守回落路径：解析器没就绪时必须交出 undefined（交空数组会被误读成「这文件真没符号」）。
*/

describe("语法树符号抽取", () => {
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it("Python：类方法标为方法、装饰器函数取 def 所在行、最后一行精确", () => {
    const source = [
      "import os", // 1
      "", // 2
      "@deco", // 3
      "def outer(a, b):", // 4
      "    return a", // 5
      "", // 6
      "class Service:", // 7
      "    def __init__(self, name):", // 8
      "        self.name = name", // 9
      "", // 10
      "    async def fetch(self, key):", // 11
      "        return key", // 12
      "" // 13
    ].join("\n");
    const symbols = extractSymbolsFromAst("svc.py", source);
    expect(symbols?.map((symbol) => `${symbol.name}:${symbol.kind}:${symbol.line}-${symbol.endLine}`)).toEqual([
      "outer:function:4-5",
      "Service:class:7-12",
      "__init__:method:8-9",
      "fetch:method:11-12"
    ]);
    expect(symbols?.find((symbol) => symbol.name === "fetch")?.parameters).toEqual(["self", "key"]);
    expect(symbols?.find((symbol) => symbol.name === "fetch")?.language).toBe("python");
  });

  it("TypeScript：接口/类型别名/枚举单独成类，类方法标为方法，导出外壳被穿透", () => {
    const source = [
      "export interface Options { a: string }", // 1
      "export type Cb = (x: number) => void;", // 2
      "export enum Kind { A, B }", // 3
      "export function run(a: string): number {", // 4
      "  return 1;", // 5
      "}", // 6
      "export const helper = async (x: number) => {", // 7
      "  return x * 2;", // 8
      "};", // 9
      "export default class Service {", // 10
      "  private n = 1;", // 11
      "  constructor(private readonly o: Options) {}", // 12
      "  async fetch(key: string): Promise<string> {", // 13
      "    return key;", // 14
      "  }", // 15
      '  static make(): Service { return new Service({ a: "x" }); }', // 16
      "}" // 17
    ].join("\n");
    const symbols = extractSymbolsFromAst("svc.ts", source);
    expect(symbols?.map((symbol) => `${symbol.name}:${symbol.kind}:${symbol.line}-${symbol.endLine}`)).toEqual([
      "Options:type:1-1",
      "Cb:type:2-2",
      "Kind:type:3-3",
      "run:function:4-6",
      "helper:function:7-9",
      "Service:class:10-17",
      "constructor:method:12-12",
      "fetch:method:13-15",
      "make:method:16-16"
    ]);
    // 类字段不是可执行体，不进符号表（否则会挤占清单名额）
    expect(symbols?.some((symbol) => symbol.name === "n")).toBe(false);
    expect(symbols?.find((symbol) => symbol.name === "constructor")?.parameters).toEqual(["private readonly o: Options"]);
  });

  it("JavaScript：箭头函数、类与类方法都能识别", () => {
    const source = [
      "function boot() {", // 1
      "  return 1;", // 2
      "}", // 3
      "class Widget {", // 4
      "  render() { return 2; }", // 5
      "}", // 6
      "const go = () => 3;", // 7
    ].join("\n");
    const symbols = extractSymbolsFromAst("app.js", source);
    expect(symbols?.map((symbol) => `${symbol.name}:${symbol.kind}:${symbol.line}-${symbol.endLine}`)).toEqual([
      "boot:function:1-3",
      "Widget:class:4-6",
      "render:method:5-5",
      "go:function:7-7"
    ]);
  });

  it("建图时记录走的哪条路，且符号表已用上语法树的准确区间", () => {
    const dir = mkdtempSync(join(tmpdir(), "parse-backend-"));
    writeFileSync(join(dir, "main.py"), "def main():\n    helper()\n\ndef helper():\n    pass\n");
    const index = indexRepository(dir);
    const graph = buildDependencyGraph(dir, index.files);
    expect(graph.parseBackend).toBe("ast");
    expect(graph.symbols.map((symbol) => `${symbol.name}:${symbol.line}-${symbol.endLine}`)).toEqual(["main:1-2", "helper:4-5"]);
    // 符号区间准了，调用归属才准：helper() 出现在第 2 行，落在 main 的区间里
    const call = graph.calls.find((edge) => edge.calleePath === "main.py" && edge.line === 2);
    expect(call?.callerSymbol).toContain("main");
  });

  it("没有对应语法的扩展名返回 undefined，交给逐行匹配", () => {
    expect(extractSymbolsFromAst("main.go", "func main() {}")).toBeUndefined();
  });

  it("解析器未加载时状态是 regex 并带原因（守回落路径）", () => {
    resetSymbolParserForTest();
    expect(parseBackendStatus().backend).toBe("regex");
    expect(parseBackendStatus().reason).toContain("尚未加载");
    expect(extractSymbolsFromAst("a.py", "def f(): pass")).toBeUndefined();
    return loadSymbolParser().then(() => {
      expect(parseBackendStatus().backend).toBe("ast");
      expect(parseBackendStatus().reason).toBeUndefined();
    });
  });
});

describe("Java 符号抽取", () => {
  it("抽到类/构造器/方法/接口，endLine 精确；language=java", async () => {
    await loadSymbolParser();
    const content = [
      "package com.hmdp;",
      "",
      "public class Foo extends Base {",
      "  private final int x;",
      "",
      "  public Foo(int x) {",
      "    this.x = x;",
      "  }",
      "",
      "  @Override",
      "  public Result query(String key) {",
      "    return helper(key);",
      "  }",
      "}",
      "",
      "interface Bar {",
      "  Result doIt(String key);",
      "}",
      ""
    ].join("\n");
    const symbols = extractSymbolsFromAst("src/main/java/com/hmdp/Foo.java", content);
    expect(symbols).toBeDefined();
    const foo = symbols!.find((symbol) => symbol.name === "Foo");
    expect(foo).toMatchObject({ kind: "class", line: 3, endLine: 14, language: "java" });
    const ctor = symbols!.find((symbol) => symbol.name === "Foo" && symbol.kind === "method");
    expect(ctor).toBeDefined();
    expect(ctor?.endLine).toBe(8);
    const query = symbols!.find((symbol) => symbol.name === "query");
    expect(query).toMatchObject({ kind: "method", endLine: 13 });
    const bar = symbols!.find((symbol) => symbol.name === "Bar");
    expect(bar).toMatchObject({ kind: "type", line: 16, endLine: 18 });
  });
});
