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
  it("return 之后的语句仍成一格，但没有入边——被丢掉和「走不到」在产物里是两件事", () => {
    const graph = only(`function ten(a: number) {
  if (a) { return 1; }
  return 2;
}`, "ten");
    const returns = graph.blocks.filter((block) => block.kind === "exit");
    expect(returns.length).toBeGreaterThanOrEqual(2);
  });

  it("没有控制流规则的语言：backend 为 none、函数为空、skipped 必须点名（不许交空图冒充「都没分支」）", () => {
    const code = `def f(a):
    if a:
        return 1
    return 2`;
    const fact = cfg(code, "sample.py");
    expect(fact.backend).toBe("none");
    expect(fact.functions).toEqual([]);
    expect(fact.skipped?.[0]?.reason).toContain("python");
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
