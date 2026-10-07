import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph, impactRadius } from "./graph.js";
import { classifyFileRoles, fileStructureOf } from "./roles.js";
import { loadSymbolParser } from "./parser.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/frozen-demo-repo");
const tsFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/tsnext-demo-repo");
const pyFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/pydemo-repo");
const pyFrameworkFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/pyframeworkdemo-repo");
const javaFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/javademo-repo");

describe("dependency graph v1", () => {
  it("returns callers in the impact radius of a changed imported file", () => {
    const index = indexRepository(fixture);
    const graph = buildDependencyGraph(fixture, index.files);
    const impact = impactRadius(graph, ["src/config.js"]);
    expect(impact.impactedPaths).toContain("src/config.js");
    expect(impact.impactedPaths).toContain("src/main.js");
    expect(impact.edges).toContainEqual(expect.objectContaining({ from: "src/main.js", to: "src/config.js", kind: "import" }));
    rmSync(join(fixture, ".tutor"), { recursive: true, force: true });
  });

  it("resolves NodeNext .js specifiers to .ts files", () => {
    const index = indexRepository(tsFixture);
    const graph = buildDependencyGraph(tsFixture, index.files);
    expect(graph.imports.get("src/main.ts")).toContain("src/util.ts");
    rmSync(join(tsFixture, ".tutor"), { recursive: true, force: true });
  });

  it("resolves bare specifiers to workspace packages via their package.json name", () => {
    const index = indexRepository(tsFixture);
    const graph = buildDependencyGraph(tsFixture, index.files);
    expect(graph.imports.get("src/main.ts")).toContain("packages/lib/src/index.ts");
    rmSync(join(tsFixture, ".tutor"), { recursive: true, force: true });
  });
});

describe("dependency graph — Python 模块解析", () => {
  it("resolves dotted module names to repository files (绝对导入) and treats main.py as an entrypoint", () => {
    const index = indexRepository(pyFixture);
    const graph = buildDependencyGraph(pyFixture, index.files);
    expect(graph.imports.get("main.py")).toContain("app/service.py");
    expect(graph.imports.get("main.py")).toContain("app/store.py");
    expect(graph.imports.get("main.py")).toContain("app/rel.py");
    // `from app.store import load`：只解析到模块，函数名不入图
    expect(graph.imports.get("app/service.py")).toEqual(["app/store.py"]);
    expect(graph.entrypoints.map((item) => item.path)).toContain("main.py");
    // 只有脚本守卫的普通脚本：锚点从第 1 行挪到 `if __name__ == "__main__":` 那一行
    expect(graph.entrypoints).toContainEqual({ path: "main.py", line: 12, label: "脚本主入口" });
    rmSync(join(pyFixture, ".tutor"), { recursive: true, force: true });
  });

  it("resolves relative imports against the current package (from .store import load)", () => {
    const index = indexRepository(pyFixture);
    const graph = buildDependencyGraph(pyFixture, index.files);
    expect(graph.imports.get("app/rel.py")).toEqual(["app/store.py"]);
    rmSync(join(pyFixture, ".tutor"), { recursive: true, force: true });
  });

  it("produces cross-file call edges for Python modules", () => {
    const index = indexRepository(pyFixture);
    const graph = buildDependencyGraph(pyFixture, index.files);
    const crossFile = graph.calls.filter((call) => call.callerPath !== call.calleePath);
    expect(crossFile).toContainEqual(expect.objectContaining({ callerPath: "main.py", calleePath: "app/service.py" }));
    expect(crossFile).toContainEqual(expect.objectContaining({ callerPath: "app/service.py", calleePath: "app/store.py" }));
    expect(crossFile).toContainEqual(expect.objectContaining({ callerPath: "app/rel.py", calleePath: "app/store.py" }));
    rmSync(join(pyFixture, ".tutor"), { recursive: true, force: true });
  });
});

describe("Python 框架入口（fixture 先于规则）", () => {
  it("Flask：入口锚在 app 构造行；同文件的路由与启动语句不再各出一条", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "flaskshop/shop.py", line: 10, label: "HTTP 应用 (Flask)" });
    // 一个文件只有一条锚点：真仓一个 main.py 挂着十几条路由，逐条标会把入口清单变成路由清单
    expect(graph.entrypoints.filter((item) => item.path === "flaskshop/shop.py")).toHaveLength(1);
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("FastAPI：应用对象与路由写在同一文件时锚在构造行", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "fastapiapp/orders.py", line: 10, label: "HTTP 应用 (FastAPI)" });
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("路由模块：只有装饰器（Flask 蓝图的 .route、FastAPI APIRouter 的 .get）也入围，锚在第一条装饰器", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "flaskshop/reviews.py", line: 12, label: "HTTP 路由 (Flask)" });
    expect(graph.entrypoints).toContainEqual({ path: "fastapiapp/shipments.py", line: 12, label: "HTTP 路由 (FastAPI)" });
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("启动文件：app.run / uvicorn.run 优先于同文件的脚本守卫；认不出框架名就不带框架名", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    // serve.py 的守卫在 11 行、启动在 12 行；标签不写框架，因为 `from flaskshop.shop` 是仓内包名而不是 flask
    expect(graph.entrypoints).toContainEqual({ path: "flaskshop/serve.py", line: 12, label: "HTTP 服务启动" });
    expect(graph.entrypoints).toContainEqual({ path: "fastapiapp/run.py", line: 14, label: "HTTP 服务启动" });
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("Django：urlpatterns 是路由表入口，manage.py 从文件名猜测升成权威锚点", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "djangoshop/shop/urls.py", line: 12, label: "HTTP 路由表 (Django)" });
    expect(graph.entrypoints).toContainEqual({ path: "djangoshop/manage.py", line: 21, label: "脚本主入口 (Django)" });
    // manage 本来就在文件名约定里：同一个文件不能既报「脚本主入口」又报「conventional entrypoint」
    expect(graph.entrypoints.filter((item) => item.path === "djangoshop/manage.py")).toHaveLength(1);
    // 路由表指向的视图靠相对导入落点：入口与它要讲的正文之间得有一条边
    expect(graph.imports.get("djangoshop/shop/urls.py")).toContain("djangoshop/shop/views.py");
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("普通脚本：只有 if __name__ 守卫的，锚点落在那一行且不带框架名", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    expect(graph.entrypoints).toContainEqual({ path: "tools/export_csv.py", line: 16, label: "脚本主入口" });
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });

  it("负例：Django 视图与纯库文件不是入口；整仓入口就是框架证据那九条", () => {
    const index = indexRepository(pyFrameworkFixture);
    const graph = buildDependencyGraph(pyFrameworkFixture, index.files);
    const paths = graph.entrypoints.map((item) => item.path);
    // 视图由 urls.py 那张表决定谁来调；库文件只有函数定义与非路由装饰器（property/lru_cache）
    expect(paths).not.toContain("djangoshop/shop/views.py");
    expect(paths).not.toContain("library/prices.py");
    expect([...paths].sort()).toEqual([
      "djangoshop/manage.py",
      "djangoshop/shop/urls.py",
      "fastapiapp/orders.py",
      "fastapiapp/run.py",
      "fastapiapp/shipments.py",
      "flaskshop/reviews.py",
      "flaskshop/serve.py",
      "flaskshop/shop.py",
      "tools/export_csv.py"
    ]);
    rmSync(join(pyFrameworkFixture, ".tutor"), { recursive: true, force: true });
  });
});

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
    // 直接导入与静态导入同一文件 → 合并成一条；`com.demo.util.*` 只带来**正文真引用过**的 Metrics，
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

  it("detects entrypoints from Spring annotations, boot class first with class-line anchors", () => {
    const index = indexRepository(javaFixture);
    const graph = buildDependencyGraph(javaFixture, index.files);
    expect(graph.entrypoints[0]).toEqual({ path: "src/main/java/com/demo/DemoApplication.java", line: 7, label: "Spring Boot 启动类" });
    expect(graph.entrypoints).toContainEqual({ path: "src/main/java/com/demo/shop/ShopController.java", line: 12, label: "HTTP 路由 (Spring MVC)：/shop" });
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

describe("入口候选剔除测试路径", () => {
  it("package.json scripts 指向 test-fixtures 内的文件不再成为入口；真实入口保留", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "tutor-entry-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        scripts: { start: "tsx test-fixtures/demo/main.ts", dev: "tsx src/real-entry.ts" }
      }));
      mkdirSync(join(dir, "test-fixtures/demo"), { recursive: true });
      writeFileSync(join(dir, "test-fixtures/demo/main.ts"), "export const x = 1;\n");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/real-entry.ts"), "import { y } from \"./util.ts\";\nconsole.log(y);\n");
      writeFileSync(join(dir, "src/util.ts"), "export const y = 2;\n");
      const index = indexRepository(dir);
      const graph = buildDependencyGraph(dir, index.files);
      const paths = graph.entrypoints.map((item) => item.path);
      expect(paths).toContain("src/real-entry.ts");
      expect(paths.some((path) => path.includes("test-fixtures"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

describe("依赖边 — Vue SFC 与 tsconfig paths 别名", () => {
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it(".vue 内容进图：相对/别名/省略后缀都落点，第三方丢弃；tsconfig 的注释与尾逗号不致命", () =>
    withRepo("vue", {
      "tsconfig.json": "{\n  // 别名与 vite 配置保持一致\n  \"compilerOptions\": {\n    \"baseUrl\": \".\",\n    \"paths\": { \"@/*\": [\"src/*\"], },\n  },\n}\n",
      "src/App.vue": "<template>\n  <Header />\n</template>\n\n<script setup>\nimport Header from \"./components/Header.vue\";\nimport { useUser } from \"@/stores/user\";\nimport { createApp } from \"vue\";\n\nconst load = () => useUser();\n</script>\n",
      "src/components/Header.vue": "<template><h1>Hi</h1></template>\n",
      "src/stores/user.ts": "export const useUser = () => ({});\n",
      "src/main.ts": "import App from \"./App.vue\";\nimport { useUser } from \"@/stores/user\";\n\ncreateApp(App).mount(\"#app\");\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      // 声明顺序：相对 → 别名 → 第三方；vue 无落点被丢弃
      expect(graph.imports.get("src/App.vue")).toEqual(["src/components/Header.vue", "src/stores/user.ts"]);
      expect(graph.imports.get("src/main.ts")).toEqual(["src/App.vue", "src/stores/user.ts"]);
      const load = graph.symbols.find((symbol) => symbol.name === "load");
      expect(load).toMatchObject({ path: "src/App.vue", line: 10, endLine: 10, kind: "function" });
    }));

  it("无 tsconfig 时别名说明符照旧丢弃（只连有仓内证据的边）", () =>
    withRepo("vue-noalias", {
      "src/App.vue": "<script setup>\nimport { useUser } from \"@/stores/user\";\n</script>\n",
      "src/stores/user.ts": "export const useUser = () => ({});\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      expect(graph.imports.get("src/App.vue")).toEqual([]);
    }));

  it("通配以外的别名与前缀不匹配的裸说明符不落点", () =>
    withRepo("vue-alias", {
      "tsconfig.json": "{ \"compilerOptions\": { \"paths\": { \"~\": [\"src\"], \"@/*\": [\"src/*\"] } } }\n",
      "src/App.vue": "<script setup>\nimport a from \"~/stores/user\";\nimport b from \"@another/stores/user\";\nimport c from \"@/stores/user\";\n</script>\n",
      "src/stores/user.ts": "export const useUser = () => ({});\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      // exact 别名（无 `*`）不支持；`@another/` 与 `@/` 前缀不同不误配；只有 `@/` 命中
      expect(graph.imports.get("src/App.vue")).toEqual(["src/stores/user.ts"]);
    }));
});

describe("说明符落点按发起文件的语言收口（复审 #121①）", () => {
  it("TS 的 `./util` 不再连到同目录的 util.py / util.go / util.java", async () =>
    await withRepo("no-cross-language", {
      "src/a.ts": "import { x } from \"./util\";\nexport const a = x;\n",
      "src/util.py": "x = 1\n",
      "src/util.go": "package util\n",
      "src/util.java": "public class Util {}\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      // 旧写法拿全表 19 个扩展名挨个试，这一条会连到 util.py（同名不同语言优先命中）。
      // 能力表 typescript 那格自称 dependencyEdge=exact（「落点逐个验证、不是连错」），跨语言猜边正好把它戳穿。
      expect(graph.imports.get("src/a.ts") ?? []).toEqual([]);
    }));

  it("同族互连照旧：`.vue` 里 `./panel` 落的还是 `.ts`", async () =>
    await withRepo("script-family", {
      "src/comp.vue": "<script setup>\nimport { p } from \"./panel\";\n</script>\n",
      "src/panel.ts": "export const p = 1;\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      expect(graph.imports.get("src/comp.vue")).toEqual(["src/panel.ts"]);
    }));

  it(".mts / .cts 进图（能力表补上之前，parser 认它、图不认，符号被标成 other）", async () =>
    await withRepo("mts-in-graph", {
      "src/a.mts": "import { u } from \"./util.mjs\";\nexport const a = u;\n",
      "src/util.mts": "export const u = 1;\n",
      "src/legacy.cts": "export const legacy = 2;\n"
    }, (dir) => {
      const files = indexRepository(dir).files;
      expect(files.map((file) => file.path), "索引要收 .mts/.cts，否则谈不上进图").toEqual(expect.arrayContaining(["src/a.mts", "src/util.mts", "src/legacy.cts"]));
      const graph = buildDependencyGraph(dir, files);
      // `./util.mjs` 按 NodeNext 约定回落到 .ts 家族 → 命中 src/util.mts
      expect(graph.imports.get("src/a.mts")).toEqual(["src/util.mts"]);
      expect(graph.symbols.filter((symbol) => symbol.path === "src/legacy.cts").every((symbol) => symbol.language === "typescript"), "带 .cts 后缀的文件不该再被标成 other").toBe(true);
    }));
});
