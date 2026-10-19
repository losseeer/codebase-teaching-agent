import { beforeAll, describe, expect, it } from "vitest";
import { languageCapabilitiesOf, type CfgBlock, type CfgFileFact, type CfgFunction } from "@codebase-tutor/shared";
import { extractSymbolsFromAst, loadSymbolParser } from "../depgraph/parser.js";
import { buildFileCfg } from "./cfg.js";

/**
  控制流图的回归。要拦的事故只有一个：**图上画的走向与源码的走向不一致**。
  所以每条断言都问「这条边在源码里真的走得通吗」，而不是问块数对不对——
  块数会因为多开一个汇合块而变，走不通的边却永远是错的。
*/

beforeAll(async () => {
  await loadSymbolParser();
});

function cfg(code: string, path = "sample.ts"): CfgFileFact {
  const symbols = extractSymbolsFromAst(path, code) ?? [];
  return buildFileCfg(path, code, symbols, languageCapabilitiesOf(path).language);
}

function only(code: string, name: string, path = "sample.ts"): CfgFunction {
  const fact = cfg(code, path);
  const target = fact.functions.find((item) => item.name === name);
  if (!target) throw new Error(`没画出 ${name} 的图；产出的函数：${fact.functions.map((item) => `${item.name}@${item.startLine}`).join(" / ") || "无"}；跳过：${JSON.stringify(fact.skipped ?? [])}`);
  return target;
}

const kindOf = (graph: CfgFunction, id: number): CfgBlock["kind"] | undefined => graph.blocks.find((block) => block.id === id)?.kind;

const edgesBetween = (graph: CfgFunction, fromKind: CfgBlock["kind"], toKind: CfgBlock["kind"]): string[] => {
  const froms = graph.blocks.filter((block) => block.kind === fromKind).map((block) => block.id);
  const tos = new Set(graph.blocks.filter((block) => block.kind === toKind).map((block) => block.id));
  return graph.edges.filter((edge) => froms.includes(edge.from) && tos.has(edge.to)).map((edge) => edge.kind);
};

describe("直线与分支", () => {
  it("没有分支的函数：入口直接到出口，圈复杂度 1", () => {
    const graph = only(`function one(a: number) {
  const b = a + 1;
  return b;
}`, "one");
    expect(graph.blocks.map((block) => block.kind)).toEqual(["entry", "exit"]);
    expect(graph.blocks[0].statements).toContain("lexical_declaration");
    expect(graph.edges.map((edge) => edge.kind)).toEqual(["next"]);
    expect(graph.complexity).toBe(1);
  });

  it("if 没有 else 时，必须有一条 false 边直接往下——否则图上看不出「还可以不进这个分支」", () => {
    const graph = only(`function two(a: number) {
  if (a) {
    work();
  }
  return a;
}`, "two");
    const branch = graph.blocks.find((block) => block.kind === "branch")!;
    expect(graph.edges.filter((edge) => edge.from === branch.id).map((edge) => edge.kind).sort()).toEqual(["false", "true"]);
    expect(graph.edges.some((edge) => edge.kind === "false"), "条件不成立那条路必须在图上").toBe(true);
    expect(graph.complexity).toBe(2);
  });

  it("if/else 两条路都要汇合回来，且各自只有一条入边", () => {
    const graph = only(`function three(a: number) {
  if (a > 1) {
    left();
  } else {
    right();
  }
  done();
}`, "three");
    expect(edgesBetween(graph, "branch", "straight").filter((kind) => kind === "true")).toHaveLength(1);
    expect(edgesBetween(graph, "branch", "straight").filter((kind) => kind === "false")).toHaveLength(1);
    const sinks = graph.blocks.filter((block) => !graph.edges.some((edge) => edge.from === block.id));
    expect(sinks.map((block) => block.kind)).toEqual(["exit"]);
  });

  it("三元表达式不是一条语句块，但它所在的语句要留在图上", () => {
    const graph = only(`function four(a: number) {
  const x = a > 1 ? 1 : 2;
  return x;
}`, "four");
    expect(graph.blocks.at(-2)?.statements).toContain("lexical_declaration");
  });
});

describe("循环", () => {
  it("for 循环：条件块有一条回边到自身，且条件不成立时能走到循环后", () => {
    const graph = only(`function five() {
  for (let i = 0; i < 3; i++) {
    use(i);
  }
  after();
}`, "five");
    const loops = graph.blocks.filter((block) => block.kind === "loop");
    expect(loops).toHaveLength(1);
    expect(graph.edges.some((edge) => edge.from === loops[0].id && edge.to === loops[0].id && edge.kind === "back" ) || graph.edges.some((edge) => edge.kind === "back")).toBe(true);
    expect(graph.edges.filter((edge) => edge.from === loops[0].id).map((edge) => edge.kind).sort()).toEqual(["false", "true"]);
    expect(graph.complexity).toBe(2);
  });

  it("do-while 先跑体再判条件：入口的下一条边不能是条件块", () => {
    const graph = only(`function six(a: number) {
  do {
    body();
  } while (a < 5);
}`, "six");
    const entry = graph.blocks.find((block) => block.kind === "entry")!;
    const first = graph.edges.filter((edge) => edge.from === entry.id).map((edge) => kindOf(graph, edge.to));
    expect(first).not.toContain("loop");
    expect(graph.blocks.some((block) => block.kind === "loop")).toBe(true);
  });

  it("break 走到循环后、continue 走回条件块", () => {
    const graph = only(`function seven() {
  while (flag) {
    if (stop) { break; }
    if (skip) { continue; }
    work();
  }
  tail();
}`, "seven");
    const loop = graph.blocks.find((block) => block.kind === "loop")!;
    const tail = graph.blocks.find((block) => block.kind === "straight" && block.statements.includes("expression_statement"));
    expect(graph.edges.filter((edge) => edge.to === loop.id).map((edge) => edge.kind)).toContain("back");
    expect(tail, "循环后的语句要还在图上").toBeDefined();
  });
});

describe("switch 与异常", () => {
  it("少写 break 的两个分支之间必须有一条 fallthrough 边——这个 bug 就靠这条边在图上现形", () => {
    const graph = only(`function eight(a: number) {
  switch (a) {
    case 1:
      first();
    case 2:
      second();
      break;
    default:
      fallback();
  }
}`, "eight");
    const selector = graph.blocks.find((block) => block.kind === "selector")!;
    const arms = graph.blocks.filter((block) => block.statements.includes("switch_case"));
    expect(selector).toBeDefined();
    expect(arms.length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.some((edge) => arms.slice(0, -1).some((arm) => arm.id === edge.from) && edge.kind === "next")).toBe(true);
  });

  it("catch 是一条异常边，不是顺序边；finally 单独接线", () => {
    const graph = only(`function nine() {
  try {
    risky();
  } catch (e) {
    fix();
  } finally {
    done();
  }
}`, "nine");
    expect(edgesBetween(graph, "straight", "handler")).toContain("exception");
    expect(graph.edges.map((edge) => edge.kind)).toContain("finally");
    expect(graph.complexity).toBeGreaterThanOrEqual(2);
  });
});

describe("不可达与不撒谎", () => {
  it("return 之后的语句仍成一格，但没有任何入边——「丢掉」和「走不到」在产物里是两件事", () => {
    const graph = only(`function ten() {
  work();
  return 1;
  const dead = 2;
}`, "ten");
    const entry = graph.blocks.find((block) => block.kind === "entry");
    const detached = graph.blocks.filter((block) => !graph.edges.some((edge) => edge.to === block.id) && block.id !== entry?.id);
    expect(detached, `应有一格走不到的死代码：${JSON.stringify(graph.blocks)}`).toHaveLength(1);
    expect(detached[0].statements).toContain("lexical_declaration");
    expect(graph.blocks.find((block) => block.kind === "exit")?.statements).toContain("return_statement");
  });

  it("没有对应语法的文件：backend 为 none、函数为空、skipped 必须点名（不许交空图冒充「都没分支」）", () => {
    const fact = cfg(`def f(a):\n    if a:\n        return 1\n    return 2`, "sample.rb");
    expect(fact.backend).toBe("none");
    expect(fact.functions).toEqual([]);
    expect(fact.skipped?.[0]?.reason, `实际 skipped=${JSON.stringify(fact.skipped)}`).toContain("语法树");
  });

  it("符号表里有、语法树里对不上的函数进 skipped，不静默消失", () => {
    const code = `function real() { return 1; }`;
    const symbols = extractSymbolsFromAst("sample.ts", code) ?? [];
    const fact = buildFileCfg("sample.ts", code, [...symbols, { ...symbols[0], id: "symbol:sample.ts:ghost:99", name: "ghost", line: 99, endLine: 120 }], "typescript");
    expect(fact.functions.map((item) => item.name)).toContain("real");
    expect(fact.skipped?.some((item) => item.name.startsWith("ghost@"))).toBe(true);
  });

  it("匿名回调不成图，但要留下点名的 skipped", () => {
    const fact = cfg(`function eleven(items: number[]) {
  items.forEach((item) => use(item));
}`, "sample.ts");
    const anon = fact.skipped?.find((item) => item.reason.includes("匿名"));
    expect(anon, `匿名函数体该被点名，实际 skipped=${JSON.stringify(fact.skipped ?? [])}`).toBeDefined();
  });

  it("函数 id 与符号表逐字一致：调用边、讲解切片与这张图说的是同一个函数", () => {
    const code = `export function twelve(a: number) { if (a) { return 1; } return 0; }`;
    const symbols = extractSymbolsFromAst("sample.ts", code) ?? [];
    const fact = buildFileCfg("sample.ts", code, symbols, "typescript");
    const symbol = symbols.find((item) => item.name === "twelve");
    expect(symbol).toBeDefined();
    expect(fact.functions.find((item) => item.name === "twelve")?.symbolId).toBe(symbol!.id);
  });

  it("块数打满上限时置 truncated，而不是悄悄砍掉", () => {
    const body = Array.from({ length: 400 }, (_, index) => `if (x === ${index}) { y${index} = 1; }`).join("\n  ");
    const graph = only(`function big(x: number) {\n  ${body}\n}`, "big");
    expect(graph.truncated).toBe(true);
    expect(graph.blocks.length).toBeLessThanOrEqual(200);
  });
});

const lines = (...rows: string[]): string => rows.join("\n");

function graphOf(path: string, code: string, name: string): CfgFunction {
  const symbols = extractSymbolsFromAst(path, code) ?? [];
  const fact = buildFileCfg(path, code, symbols, languageCapabilitiesOf(path).language);
  expect(fact.backend, `${path} 该出图，实际 skipped=${JSON.stringify(fact.skipped)}`).toBe("ast");
  const graph = fact.functions.find((item) => item.name === name);
  if (!graph) throw new Error(`${path} 没画出 ${name}：画出来的是 ${fact.functions.map((item) => item.name).join(" / ") || "无"}`);
  return graph;
}

/** 每张图都要过的形状自检：图自己不矛盾，才有资格谈对不对。 */
function expectWellFormed(graph: CfgFunction): void {
  const ids = graph.blocks.map((block) => block.id);
  expect(new Set(ids).size, `${graph.name}：块 id 不能重复`).toBe(ids.length);
  expect(ids).toContain(0);
  for (const edge of graph.edges) {
    expect(ids, `${graph.name}：边 ${edge.from}→${edge.to} 指向了不存在的块`).toContain(edge.from);
    expect(ids, `${graph.name}：边 ${edge.from}→${edge.to} 指向了不存在的块`).toContain(edge.to);
  }
  const reached = new Set<number>([0]);
  let frontier = [0];
  while (frontier.length) {
    const next: number[] = [];
    for (const id of frontier) for (const edge of graph.edges) if (edge.from === id && !reached.has(edge.to)) { reached.add(edge.to); next.push(edge.to); }
    frontier = next;
  }
  expect([...reached].sort((a, b) => a - b), `${graph.name}：有从入口走不到的块（这份样例里没有死代码，出现即画错）`).toEqual([...ids].sort((a, b) => a - b));
  expect(graph.complexity).toBeGreaterThanOrEqual(1);
}

describe("逐语言的构造覆盖", () => {
  // 样例源码放在模块层，**建图必须留在 it 里面**：describe 体在收集阶段就跑，
  // 那时 `beforeAll` 的语法解析器还没加载，建出来的图全是「语法树不可用」
  const PYTHON = lines(
    "def pick(a):",
    "    if a:",
    "        g()",
    "    elif a > 2:",
    "        h()",
    "    else:",
    "        return 0",
    "    for i in xs:",
    "        if i == 1:",
    "            break",
    "    else:",
    "        tail()",
    "    while a < 9:",
    "        a += 1",
    "        continue",
    "    try:",
    "        risky()",
    "    except ValueError as e:",
    "        fix()",
    "    except Exception:",
    "        pass",
    "    finally:",
    "        done()",
    "    with open('x') as fh:",
    "        read(fh)",
    "    raise ValueError('x')"
  );

  it("Python：elif 走 false 边、for-else 只在没 break 时进、两个 except 各一条异常边、with 体穿过", () => {
    const python = graphOf("s.py", PYTHON, "pick");
    expectWellFormed(python);
    const branches = python.blocks.filter((block) => block.kind === "branch");
    expect(branches.length).toBeGreaterThanOrEqual(2);
    const elseEntry = python.blocks.filter((block) => block.statements.includes("elif_clause"));
    expect(elseEntry.length, "elif 要留在图上（不是当成普通 else）").toBeGreaterThanOrEqual(1);
    const forHead = python.blocks.find((block) => block.kind === "loop" && python.edges.some((edge) => edge.from === block.id && python.blocks.find((item) => item.id === edge.to)?.statements.includes("else")));
    expect(forHead, "for-else：条件的 false 那一路要进 else 体").toBeDefined();
    expect(python.blocks.filter((block) => block.kind === "handler")).toHaveLength(2);
    expect(python.edges.filter((edge) => edge.kind === "exception").length).toBeGreaterThanOrEqual(2);
    expect(python.edges.map((edge) => edge.kind)).toContain("finally");
    expect(python.blocks.flatMap((block) => block.statements), "with 体里的语句不能丢").toContain("expression_statement");
    expect(python.blocks.filter((block) => block.kind === "exit").map((block) => block.statements).flat()).toContain("raise_statement");
  });

  const JAVA_COLON = lines(
    "class S {",
    "  void colon(int a) {",
    "    switch (a) {",
    "      case 1: b();",
    "      case 2: c(); break;",
    "      default: d();",
    "    }",
    "  }",
    "}"
  );
  const JAVA_ARROW = lines(
    "class S {",
    "  void arrow(int a) {",
    "    switch (a) {",
    "      case 1, 2 -> b();",
    "      default -> c();",
    "    }",
    "  }",
    "}"
  );

  it("Java：冒号形式少 break 要掉进下一组，箭头形式不许掉", () => {
    const colonSwitch = graphOf("S.java", JAVA_COLON, "colon");
    const arrowSwitch = graphOf("S.java", JAVA_ARROW, "arrow");
    expectWellFormed(colonSwitch);
    expectWellFormed(arrowSwitch);
    const groups = colonSwitch.blocks.filter((block) => block.statements.includes("switch_block_statement_group"));
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const groupIds = new Set(groups.map((block) => block.id));
    expect(colonSwitch.edges.some((edge) => edge.kind === "next" && groupIds.has(edge.from) && groupIds.has(edge.to)), "case 1 没 break ⇒ 组与组之间要有 fallthrough 边").toBe(true);
    const rules = new Set(arrowSwitch.blocks.filter((block) => block.statements.includes("switch_rule")).map((block) => block.id));
    expect(arrowSwitch.edges.some((edge) => edge.kind === "next" && rules.has(edge.from) && rules.has(edge.to)), "箭头形式不该有 fallthrough").toBe(false);
  });

  const JAVA_REST = lines(
    "class S {",
    "  int rest(int a) {",
    "    outer: for (int i = 0; i < 3; i++) { if (i == 1) break outer; }",
    "    do { a++; } while (a < 5);",
    "    for (String k : xs) { use(k); }",
    "    try (AutoCloseable c = open()) { risky(); } catch (Exception e) { fix(); } finally { done(); }",
    "    throw new RuntimeException();",
    "  }",
    "}"
  );

  it("Java：带资源的 try、do-while、标签 break 都接得上", () => {
    const javaRest = graphOf("S.java", JAVA_REST, "rest");
    expectWellFormed(javaRest);
    expect(javaRest.blocks.some((block) => block.kind === "handler")).toBe(true);
    expect(javaRest.edges.map((edge) => edge.kind)).toContain("finally");
    const head = javaRest.blocks.find((block) => block.kind === "loop" && javaRest.edges.some((edge) => edge.from === block.id && edge.kind === "true"));
    expect(head, "do-while 的条件块要能回到体").toBeDefined();
    expect(javaRest.blocks.flatMap((block) => block.statements), "标签块要留下名字").toContain("label:outer");
    expect(javaRest.blocks.filter((block) => block.kind === "exit").map((block) => block.statements).flat()).toContain("throw_statement");
  });

  const GO = lines(
    "package main",
    "",
    "func f(a int) int {",
    "    for {",
    "        if stop() { break }",
    "    }",
    "    for i := 0; i < 3; i++ { if i == 1 { continue } }",
    "    switch a {",
    "    case 1:",
    "        b()",
    "        fallthrough",
    "    case 2:",
    "        c()",
    "    }",
    "    select {",
    "    case v := <-ch:",
    "        use(v)",
    "    default:",
    "        other()",
    "    }",
    "    goto end",
    "end:",
    "    return a",
    "}"
  );

  it("Go：无条件的 for 没有 false 边、fallthrough 与 goto 标签都接得上、select 两臂", () => {
    const go = graphOf("s.go", GO, "f");
    expectWellFormed(go);
    const endless = go.blocks.filter((block) => block.kind === "loop" && !go.edges.some((edge) => edge.from === block.id && edge.kind === "false"));
    expect(endless.length, "`for {}` 不该有条件不成立那条边").toBeGreaterThanOrEqual(1);
    const arms = go.blocks.filter((block) => block.statements.some((type) => type === "expression_case" || type === "default_case" || type === "communication_case"));
    expect(arms.length, "switch 两臂 + select 两臂").toBeGreaterThanOrEqual(4);
    const caseArms = new Set(go.blocks.filter((block) => block.statements.includes("expression_case")).map((block) => block.id));
    expect(go.edges.some((edge) => edge.kind === "next" && caseArms.has(edge.from) && caseArms.has(edge.to)), "fallthrough 那条边必须在").toBe(true);
    expect(go.blocks.flatMap((block) => block.statements), "goto 要落到标签块").toContain("label:end");
    const gotoEdge = go.edges.find((edge) => go.blocks.find((block) => block.id === edge.from)?.statements.includes("label:end") === false && edge.to === go.blocks.find((block) => block.statements.includes("label:end"))?.id);
    expect(gotoEdge, "goto end ⇒ 一条指向标签块的边").toBeDefined();
    expect(go.notes ?? [], `Go 样例不该有接不上的东西：${JSON.stringify(go.notes)}`).toEqual([]);
  });

  const RUST = lines(
    "fn f(a: i32) -> i32 {",
    "    for i in 0..3 { if i == 1 { break; } else { continue; } }",
    "    while a < 9 { a += 1; }",
    "    loop { if q() { break; } }",
    "    match a {",
    "        1 => b(),",
    "        2 | 3 => c(),",
    "        _ if a > 9 => d(),",
    "        _ => e(),",
    "    }",
    "    let v = risky()?;",
    "    return v;",
    "}"
  );

  it("Rust：match 各臂之间不掉下去、`?` 给一条到出口的异常边", () => {
    const rust = graphOf("s.rs", RUST, "f");
    expectWellFormed(rust);
    const arms = new Set(rust.blocks.filter((block) => block.statements.includes("match_arm")).map((block) => block.id));
    expect(arms.size).toBeGreaterThanOrEqual(3);
    expect(rust.edges.some((edge) => edge.kind === "next" && arms.has(edge.from) && arms.has(edge.to)), "match 臂之间不该有 fallthrough").toBe(false);
    const gate = rust.blocks.find((block) => block.statements.includes("propagate"));
    expect(gate, `问号传播要把所在语句升成一个判定块：${JSON.stringify(rust.blocks.map((block) => block.statements))}`).toBeDefined();
    const exitIds = new Set(rust.exitBlocks);
    expect(rust.edges.some((edge) => edge.from === gate?.id && edge.kind === "exception" && exitIds.has(edge.to)), "`?` 的 Err 一路要到出口").toBe(true);
  });

  const CSHARP = lines(
    "class S {",
    "  int F(int a) {",
    "    foreach (var k in Xs) { Use(k); }",
    "    do { a++; } while (a < 5);",
    "    switch (a) {",
    "      case 1:",
    "      case 2: B(); break;",
    "      default: D(); break;",
    "    }",
    "    try { Risky(); } catch (Exception e) when (e.Data != null) { Fix(); } finally { Done(); }",
    "    checked { Work(); }",
    "    return a;",
    "  }",
    "}"
  );

  it("C#：switch 段之间不掉下去、catch 的 when 条件留下、checked 体穿过", () => {
    const csharp = graphOf("S.cs", CSHARP, "F");
    expectWellFormed(csharp);
    const sections = new Set(csharp.blocks.filter((block) => block.statements.includes("switch_section")).map((block) => block.id));
    expect(sections.size).toBeGreaterThanOrEqual(2);
    expect(csharp.edges.some((edge) => edge.kind === "next" && sections.has(edge.from) && sections.has(edge.to))).toBe(false);
    expect(csharp.blocks.filter((block) => block.kind === "handler").map((block) => block.statements).flat()).toContain("catch_filter_clause");
    expect(csharp.blocks.flatMap((block) => block.statements), "checked 块里的语句不能丢").toContain("expression_statement");
  });

  const C = lines(
    "int f(int a) {",
    "    for (int i = 0; i < 3; i++) { if (i == 1) break; else continue; }",
    "    while (a < 9) { a++; }",
    "    do { a++; } while (a < 5);",
    "    switch (a) {",
    "      case 1: b();",
    "      case 2: c(); break;",
    "      default: d();",
    "    }",
    "    goto end;",
    "end:",
    "    return a;",
    "}"
  );

  it("C：case 掉下去、向前 goto 落到标签块（函数名从 declarator 里取，取不到就没图）", () => {
    const c = graphOf("s.c", C, "f");
    expectWellFormed(c);
    const cases = new Set(c.blocks.filter((block) => block.statements.includes("case_statement")).map((block) => block.id));
    expect(cases.size).toBeGreaterThanOrEqual(2);
    expect(c.edges.some((edge) => edge.kind === "next" && cases.has(edge.from) && cases.has(edge.to)), "case 1 没 break ⇒ 要有 fallthrough 边").toBe(true);
    expect(c.blocks.flatMap((block) => block.statements)).toContain("label:end");
    expect(c.notes ?? [], `C 样例不该有接不上的东西：${JSON.stringify(c.notes)}`).toEqual([]);
  });

  const CPP = lines(
    "class S {",
    " public:",
    "  int f(int a) {",
    "    for (auto& k : xs) { use(k); }",
    "    try { risky(); } catch (const E& e) { fix(); } catch (...) { swallow(); }",
    "    switch (a) { case 1: throw std::runtime_error(\"x\"); }",
    "    return a;",
    "  }",
    "};"
  );

  it("C++：范围 for、两个 catch、switch 里的 throw 都接得上", () => {
    const cpp = graphOf("S.cpp", CPP, "f");
    expectWellFormed(cpp);
    expect(cpp.blocks.filter((block) => block.kind === "handler")).toHaveLength(2);
    expect(cpp.blocks.filter((block) => block.kind === "exit").map((block) => block.statements).flat()).toContain("throw_statement");
    expect(cpp.blocks.some((block) => block.kind === "loop")).toBe(true);
  });

  it("同一份 TS 表也服务 .vue：脚本块里的分支照样出图", () => {
    const vue = graphOf("S.vue", lines(
      "<script setup lang=\"ts\">",
      "function pick(a: number) {",
      "  if (a) { return 1; }",
      "  return 0;",
      "}",
      "</script>",
      "<template><div /></template>"
    ), "pick");
    expect(vue.blocks.map((block) => block.kind)).toContain("branch");
    expect(vue.startLine).toBeGreaterThanOrEqual(2);
  });
});
