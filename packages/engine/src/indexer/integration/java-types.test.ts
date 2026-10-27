import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { indexRepository } from "../indexer.js";
import { buildDependencyGraph } from "@codebase-tutor/analysis";
import { classifyFileRoles, fileStructureOf } from "@codebase-tutor/analysis";
import { loadSymbolParser } from "@codebase-tutor/analysis";

const javaFixture = join(dirname(fileURLToPath(import.meta.url)), "../../../../../test-fixtures/javademo-repo");

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

  it("resolves import statements (含静态导入) to repository files; 通配符按正文引用落点", () => {
    const index = indexRepository(javaFixture);
    const graph = buildDependencyGraph(javaFixture, index.files);
    expect(graph.imports.get("src/main/java/com/demo/DemoApplication.java")).toEqual(["src/main/java/com/demo/shop/ShopController.java"]);
    expect(graph.imports.get("src/main/java/com/demo/shop/ShopService.java")).toEqual(["src/main/java/com/demo/util/Keys.java"]);
    // 直接导入与静态导入同一文件 → 合并成一条；`com.demo.util.*` 只带来正文真引用过的 Metrics，
    // 不引 Counters（整包展开会让同包文件两两连边，影响范围虚胖）
    expect(graph.imports.get("src/main/java/com/demo/shop/ShopController.java")).toEqual([
      "src/main/java/com/demo/order/IOrderFacade.java",
      "src/main/java/com/demo/util/Keys.java",
      "src/main/java/com/demo/util/Metrics.java"
    ]);
    // 没人引用的同包类不会因为别人写了通配 import 就被连进来
    expect([...graph.imports.values()].flat()).not.toContain("src/main/java/com/demo/util/Counters.java");
    rmSync(join(javaFixture, ".tutor"), { recursive: true, force: true });
  });

  it("类头的 implements/extends 落成类型派发边；落点只认 import 过或同包的类", () => {
    const index = indexRepository(javaFixture);
    const graph = buildDependencyGraph(javaFixture, index.files);
    expect(graph.dispatch).toContainEqual({
      subtypePath: "src/main/java/com/demo/order/OrderFacadeImpl.java",
      supertypePath: "src/main/java/com/demo/order/IOrderFacade.java",
      kind: "implements",
      line: expect.any(Number)
    });
    // 实现类自己 import 的 Mapper 是普通依赖边，不该被重复记成派发边
    expect(graph.dispatch.map((edge) => edge.subtypePath)).not.toContain("src/main/java/com/demo/order/OrderMapper.java");
    // 框架类型（不在仓里）不落边：`implements Serializable` 这类只会指向空
    expect([...graph.dispatch.map((edge) => edge.supertypePath), ...graph.dispatch.map((edge) => edge.subtypePath)]
      .every((path) => index.files.some((file) => file.path === path))).toBe(true);
    rmSync(join(javaFixture, ".tutor"), { recursive: true, force: true });
  });

  it("接口在入口一跳内时，实现类经派发透传也算主干；实现下面的 Mapper 仍算二跳", () => {
    const index = indexRepository(javaFixture);
    const graph = buildDependencyGraph(javaFixture, index.files);
    const roles = classifyFileRoles(fileStructureOf(index.files, graph));
    expect(roles.get("src/main/java/com/demo/order/IOrderFacade.java")).toBe("core");
    expect(roles.get("src/main/java/com/demo/order/OrderFacadeImpl.java")).toBe("core");
    expect(roles.get("src/main/java/com/demo/order/OrderMapper.java")).toBe("support");
    rmSync(join(javaFixture, ".tutor"), { recursive: true, force: true });
  });

});

describe("整仓自环与「每个文件一个源码根」", () => {
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it("Java 扁平布局（没有 src/main|test）：同包可见与包通配都还在工作", async () =>
    await withRepo("java-flat-layout", {
      "App.java": "package com.demo;\n\nimport com.demo.util.*;\n\npublic class App {\n  void run() {\n    Service.ping();\n    Keys.check();\n  }\n}\n",
      "Service.java": "package com.demo;\n\npublic class Service {\n  public static void ping() {}\n}\n",
      "util/Keys.java": "package com.demo.util;\n\npublic class Keys {\n  public static void check() {}\n}\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      // 扁平布局没有 src/main|test，源码根兜底必须给仓根而不是文件自身：
      // 返回文件自身时每个文件都自成一个编译范围，`requireSameRoot` 恒不成立，
      // 同包可见与通配展开整条静默失效（读数上只是「这仓边少」）。
      expect(graph.imports.get("App.java"), "包通配要在扁平布局里按正文引用落点").toEqual(["util/Keys.java"]);
      expect(graph.calls.some((call) => call.callerPath === "App.java" && call.calleePath === "Service.java"), "Java 同包不 import 也互相可见").toBe(true);
    }));

});
