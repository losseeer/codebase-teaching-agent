import { beforeAll, describe, expect, it } from "vitest";
import { languageCapabilitiesOf, type DeclaredType, type SymbolInfo } from "@codebase-tutor/domain";

import { extractSymbolsFromAst, loadSymbolParser } from "../depgraph/parser.js";
import { analyzeFile } from "./build.js";

/**
  两个方向：
  1. 标量与内置类型不能当项目类型收进表里（否则每个仓都有一堆 `int`→`int` 的假边）。
  2. 落点不能猜错还不说：同名类型必须报 `ambiguous`，查不到就什么都不写。
*/

beforeAll(async () => {
  await loadSymbolParser();
});

function symbol(name: string, kind: SymbolInfo["kind"], path: string, line = 1): SymbolInfo {
  return { id: `symbol:${path}:${name}:${line}`, name, kind, path, line, endLine: line, parameters: [], language: "typescript" };
}

function types(code: string[], path = "sample.ts", extra: SymbolInfo[] = []): DeclaredType[] {
  const source = code.join("\n");
  const own = extractSymbolsFromAst(path, source) ?? [];
  return analyzeFile(path, source, own, languageCapabilitiesOf(path).language, [...own, ...extra]).types.types;
}

const declared = (fact: DeclaredType[], name: string): DeclaredType => {
  const found = fact.find((item) => item.name === name);
  if (!found) throw new Error(`没有声明类型 ${name}，实际有：${fact.map((item) => item.name).join(" / ")}`);
  return found;
};

const kindsOf = (row: DeclaredType): string[] => row.relations.map((edge) => `${edge.kind}:${edge.to}`);

describe("类型关系", () => {
  it("TypeScript：extends / implements / 参数类型 / 返回类型 / 字段类型都收进来", () => {
    const fact = types([
      "interface Base { id: string }",
      "abstract class Animal<T> implements Base {",
      "  protected repo: Repo = null;",
      "  constructor(seed: Seed) {}",
      "  move(speed: number): Promise<void> { return Promise.resolve(); }",
      "}",
      "class Dog extends Animal<string> implements Base { }"
    ]);
    expect(kindsOf(declared(fact, "Dog")).sort()).toEqual(["extends:Animal", "implements:Base"]);
    const animal = declared(fact, "Animal");
    expect(kindsOf(animal)).toContain("implements:Base");
    expect(kindsOf(animal)).toContain("field:Repo");
    expect(kindsOf(animal)).toContain("parameter:Seed");
    expect(kindsOf(animal)).toContain("returns:Promise");
  });

  it("标量与内置类型不进表：`int`/`string`/`number` 不是项目里的类型", () => {
    const fact = types([
      "class Box {",
      "  size: number = 0;",
      "  name: string = '';",
      "  get width(): number { return this.size; }",
      "}"
    ]);
    expect(declared(fact, "Box").relations).toEqual([]);
  });

  it("落点：唯一声明才写 toFile；同名多解写 ambiguous 且不写 toFile", () => {
    const solo = types(["class Dog extends Kennel { }"], "a.ts", [symbol("Kennel", "class", "src/kennel.ts")]);
    expect(declared(solo, "Dog").relations.find((edge) => edge.to === "Kennel")?.toFile).toBe("src/kennel.ts");

    const dup = types(["class Dog extends Kennel { }"], "b.ts", [symbol("Kennel", "class", "src/one.ts"), symbol("Kennel", "class", "src/two.ts")]);
    const edge = declared(dup, "Dog").relations.find((item) => item.to === "Kennel");
    expect(edge?.toFile, "同名多解不该挑一个当答案").toBeUndefined();
    expect(edge?.ambiguous).toEqual(["src/one.ts", "src/two.ts"]);

    const missing = types(["class Dog extends Kennel { }"]);
    const none = declared(missing, "Dog").relations.find((item) => item.to === "Kennel");
    expect(none?.toFile, "仓里没有这个类型就是不写，不是猜一个").toBeUndefined();
    expect(none?.ambiguous).toBeUndefined();
  });

  it("Java：泛型上界与实参、接口列表", () => {
    const fact = types([
      "interface I { }",
      "class A<T extends Comparable<T>> implements I {",
      "  List<T> items;",
      "  Map<String, List<Integer>> move(int speed) { return null; }",
      "}",
      "class D extends A<String> implements I { }"
    ], "A.java");
    const d = kindsOf(declared(fact, "D"));
    expect(d).toContain("extends:A");
    expect(d).toContain("implements:I");
    const a = declared(fact, "A");
    expect(kindsOf(a)).toContain("field:List");
    expect(kindsOf(a)).toContain("returns:Map");
    expect(kindsOf(a)).toContain("extends:Comparable");
  });

  it("Go：结构体嵌入字段与方法返回类型", () => {
    const fact = types([
      "package main",
      "",
      "type Base struct {",
      "    Items []string",
      "}",
      "type Dog struct {",
      "    Base",
      "    name string",
      "}",
      "func (d *Dog) Move(speed int) (*Base, error) { return nil, nil }"
    ], "s.go");
    expect(declared(fact, "Dog").kind).toBe("struct");
    expect(kindsOf(declared(fact, "Dog"))).toContain("field:Base");
  });

  it("Rust：trait 实现与结构体字段", () => {
    const fact = types([
      "trait Greetable { fn greet(&self) -> String; }",
      "struct Repo { items: Vec<Kit> }",
      "impl Greetable for Repo {",
      "    fn greet(&self) -> String { String::new() }",
      "}"
    ], "s.rs");
    expect(declared(fact, "Repo").kind).toBe("struct");
    // `items: Vec<Kit>`：字段类型是 Vec，Kit 是它的泛型实参，两格分开记
    expect(kindsOf(declared(fact, "Repo"))).toEqual(expect.arrayContaining(["field:Vec", "generic-argument:Kit"]));
    const impl = fact.find((item) => item.name === "Repo" && item.relations.some((edge) => edge.kind === "implements"));
    expect(impl?.relations.map((edge) => `${edge.kind}:${edge.to}`)).toContain("implements:Greetable");
  });

  it("函数体内的匿名结构体不算声明类型（它没有可被引用的名字）", () => {
    const fact = types([
      "package main",
      "",
      "func f() {",
      "    x := struct { A int }{}",
      "    _ = x",
      "}"
    ], "anon.go");
    expect(fact, `匿名结构体不该进声明表：${JSON.stringify(fact.map((item) => item.name))}`).toEqual([]);
  });
});
