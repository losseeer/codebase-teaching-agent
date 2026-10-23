import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph } from "./graph.js";
import { loadSymbolParser } from "./parser.js";

const javaFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/javademo-repo");

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

describe("dependency graph — Java/Spring", () => {
  // Java 的符号只来自语法树（回落档不认 Java），不加载解析器就没有任何调用边
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it("变量接收者按声明类型落点：字段、参数、局部变量三种形状", () => {
    const index = indexRepository(javaFixture);
    const graph = buildDependencyGraph(javaFixture, index.files);
    const implToMapper = graph.calls.find((call) => call.callerPath.endsWith("OrderFacadeImpl.java") && call.calleePath.endsWith("OrderMapper.java"));
    expect(implToMapper?.calleeSymbol).toContain(":insert:");
    // 局部变量声明的类型也要认得到：只解字段的话这条边会凭空消失
    const validatorToMapper = graph.calls.find((call) => call.callerPath.endsWith("OrderValidator.java") && call.calleePath.endsWith("OrderMapper.java"));
    expect(validatorToMapper?.calleeSymbol).toContain(":insert:");
    rmSync(join(javaFixture, ".tutor"), { recursive: true, force: true });
  });

});

describe("整仓自环与「每个文件一个源码根」", () => {
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it("Java 无修饰符的声明行不算调用（接口方法与包私有构造器），真递归仍留着", async () =>
    await withRepo("java-declaration-line", {
      "IOrder.java": "package com.demo;\n\npublic interface IOrder {\n  String submit();\n}\n",
      "Holder.java": "package com.demo;\n\npublic class Holder {\n  Holder() {\n    reset();\n  }\n\n  int fact(int n) {\n    if (n > 1) {\n      return n * fact(n - 1);\n    }\n    return 1;\n  }\n\n  void reset() {}\n}\n",
      "One.java": "package com.demo;\n\npublic class One {\n  int f(int n) { return n > 1 ? n * f(n - 1) : 1; }\n}\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      const byId = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
      // 落在「它自己的声明行」上的自环才是假边：模型据此读到「submit() 调用 submit()」，热点排序也被顶高。
      // One.java 例外——它是单行函数体，真递归就写在声明那一行，正好处在下面那条断言里。
      const declaredSelfCall = graph.calls.filter((call) => {
        const caller = call.callerSymbol ? byId.get(call.callerSymbol) : undefined;
        return caller !== undefined && caller.id === call.calleeSymbol && call.line === caller.line && call.callerPath !== "One.java";
      });
      expect(declaredSelfCall.map((call) => `${call.callerPath}:${call.line}`), "声明行匹配到的「名字(」就是它自己，不是调用").toEqual([]);
      const fact = graph.symbols.find((symbol) => symbol.name === "fact");
      expect(graph.calls.some((call) => call.callerSymbol === fact?.id && call.calleeSymbol === fact?.id), "递归调用写在别的行上，这条边要留着").toBe(true);
      // 单行函数体里递归与声明挤在同一行：按「整行跳过」会把它一起吃掉，所以判据只看左括号之前那一段
      const one = graph.symbols.find((symbol) => symbol.name === "f");
      expect(graph.calls.filter((call) => call.callerSymbol === one?.id && call.calleeSymbol === one?.id).length, "单行函数的真递归不能被声明行判据吃掉").toBe(1);
    }));

});
