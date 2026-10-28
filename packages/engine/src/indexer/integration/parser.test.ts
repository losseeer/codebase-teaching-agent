import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildDependencyGraph } from "@codebase-tutor/analysis";
import { indexRepository } from "../indexer.js";
import { extractSymbolsFromAst, loadSymbolParser, parseBackendStatus, resetSymbolParserForTest } from "@codebase-tutor/analysis";

/**
  语法树符号抽取用例。
  解析器未就绪时 extractSymbolsFromAst 返回 undefined，建图侧据此回落逐行匹配。
*/

describe("语法树符号抽取", () => {
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it("Python：类方法标为方法、装饰器函数取 def 所在行、最后一行精确", () => {
    const source = [
      "import os",
      "",
      "@deco",
      "def outer(a, b):",
      "    return a",
      "",
      "class Service:",
      "    def __init__(self, name):",
      "        self.name = name",
      "",
      "    async def fetch(self, key):",
      "        return key",
      ""
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
      "export interface Options { a: string }",
      "export type Cb = (x: number) => void;",
      "export enum Kind { A, B }",
      "export function run(a: string): number {",
      "  return 1;",
      "}",
      "export const helper = async (x: number) => {",
      "  return x * 2;",
      "};",
      "export default class Service {",
      "  private n = 1;",
      "  constructor(private readonly o: Options) {}",
      "  async fetch(key: string): Promise<string> {",
      "    return key;",
      "  }",
      '  static make(): Service { return new Service({ a: "x" }); }',
      "}"
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
    // 类字段不进符号表
    expect(symbols?.some((symbol) => symbol.name === "n")).toBe(false);
    expect(symbols?.find((symbol) => symbol.name === "constructor")?.parameters).toEqual(["private readonly o: Options"]);
  });

  it("JavaScript：箭头函数、类与类方法都能识别", () => {
    const source = [
      "function boot() {",
      "  return 1;",
      "}",
      "class Widget {",
      "  render() { return 2; }",
      "}",
      "const go = () => 3;",
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
    const call = graph.calls.find((edge) => edge.calleePath === "main.py" && edge.line === 2);
    expect(call?.callerSymbol).toContain("main");
  });

  it("逐行匹配回落的能力上限：findEndLine 在四种声明形态下的边界", async () => {
    resetSymbolParserForTest();
    const dir = mkdtempSync(join(tmpdir(), "regex-endline-"));
    const source = [
      "const a = (x) => x + 1;",
      "const b = (x) => {",
      "  return x + 2;",
      "};",
      // `=>` 收尾，块在下一行
      "const c = (x) =>",
      "  { return x + 3; };",
      "function d(x) { return x; }"
    ].join("\n");
    writeFileSync(join(dir, "m.ts"), source);
    const index = indexRepository(dir);
    const graph = buildDependencyGraph(dir, index.files);
    expect(graph.parseBackend).toBe("regex");
    expect(graph.symbols.map((symbol) => `${symbol.name}:${symbol.line}-${symbol.endLine}`)).toEqual([
      "a:1-1", "b:2-4", "c:5-6", "d:7-7"
    ]);
    await loadSymbolParser();
  });

  it("没有对应语法的扩展名返回 undefined，交给逐行匹配", () => {
    expect(extractSymbolsFromAst("legacy.x10", "<template><div/></template>")).toBeUndefined();
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

describe("新增语言符号抽取（Go/Rust/C）", () => {
  it("Go：type_declaration 展开到 type_spec（struct/interface 记 class、别名记 type），方法升为 method", async () => {
    await loadSymbolParser();
    const source = [
      "package main",
      "",
      "type Config struct {",
      "\tName string",
      "}",
      "",
      "type Handler interface {",
      "\tHandle()",
      "}",
      "",
      "type Alias int",
      "",
      "func (c *Config) Name() string {",
      "\treturn c.Name",
      "}",
      "",
      "func main() {}",
      ""
    ].join("\n");
    const symbols = extractSymbolsFromAst("main.go", source);
    expect(symbols?.map((symbol) => `${symbol.name}:${symbol.kind}:${symbol.line}-${symbol.endLine}`)).toEqual([
      "Config:class:3-5",
      "Handler:class:7-9",
      "Alias:type:11-11",
      "Name:method:13-15",
      "main:function:17-17"
    ]);
    expect(symbols?.[0]?.language).toBe("go");
  });

  it("Rust：impl 体内的 fn 升为 method；struct/trait 有位置", async () => {
    await loadSymbolParser();
    const source = [
      "pub struct Point { x: i32 }",
      "",
      "impl Point {",
      "\tpub fn zero() -> Point { Point { x: 0 } }",
      "}",
      "",
      "fn helper() {}",
      ""
    ].join("\n");
    const symbols = extractSymbolsFromAst("src/geom.rs", source);
    expect(symbols?.map((symbol) => `${symbol.name}:${symbol.kind}`)).toEqual([
      "Point:class",
      "zero:method",
      "helper:function"
    ]);
    expect(symbols?.find((symbol) => symbol.name === "helper")?.language).toBe("rust");
  });

  it("C：function_definition 没有 name 字段，名字从 declarator 链取", async () => {
    await loadSymbolParser();
    const source = [
      "int add(int a, int b) {",
      "\treturn a + b;",
      "}",
      "",
      "int *make(int v) { return 0; }",
      ""
    ].join("\n");
    const symbols = extractSymbolsFromAst("calc.c", source);
    expect(symbols?.map((symbol) => `${symbol.name}:${symbol.kind}:${symbol.line}`)).toEqual([
      "add:function:1",
      "make:function:5"
    ]);
    expect(symbols?.[0]?.language).toBe("cpp");
  });
});

describe("Vue SFC 符号抽取", () => {
  it("script setup 块的符号带全文件行号，模板与样式不进语法树", async () => {
    await loadSymbolParser();
    const source = [
      "<template>",
      "  <div>{{ user.name }}</div>",
      "</template>",
      "",
      "<script setup>",
      "const load = async () => {",
      "  return fetchUser();",
      "};",
      "</script>",
      "",
      // 样式块里的花括号与伪声明不进语法树
      "<style scoped>",
      ".box { class function weird( }",
      "</style>",
      ""
    ].join("\n");
    const symbols = extractSymbolsFromAst("src/App.vue", source);
    expect(symbols?.map((symbol) => `${symbol.name}:${symbol.kind}:${symbol.line}-${symbol.endLine}`)).toEqual(["load:function:6-8"]);
    expect(symbols?.[0]?.language).toBe("other");
  });

  it("lang=\"ts\" 走 TS 语法：接口成 type；多块各自定位", async () => {
    await loadSymbolParser();
    const source = [
      "<script lang=\"ts\">",
      "export interface Row { id: number }",
      "</script>",
      "",
      "<script setup lang=\"ts\">",
      "export default function boot() {}",
      "</script>",
      ""
    ].join("\n");
    const symbols = extractSymbolsFromAst("src/Grid.vue", source);
    expect(symbols?.map((symbol) => `${symbol.name}:${symbol.kind}:${symbol.line}`)).toEqual(["Row:type:2", "boot:function:6"]);
  });

  it("无 script 块的 SFC 是空数组（真没符号），不是 undefined", async () => {
    await loadSymbolParser();
    expect(extractSymbolsFromAst("src/Static.vue", "<template><p>hi</p></template>\n")).toEqual([]);
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
