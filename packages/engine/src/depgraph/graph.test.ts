import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph, impactRadius } from "./graph.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/frozen-demo-repo");
const tsFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/tsnext-demo-repo");
const pyFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/pydemo-repo");
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

describe("dependency graph — Java/Spring", () => {
  it("resolves import statements (含静态导入) to repository files; 外部包与通配符不入图", () => {
    const index = indexRepository(javaFixture);
    const graph = buildDependencyGraph(javaFixture, index.files);
    expect(graph.imports.get("src/main/java/com/demo/DemoApplication.java")).toEqual(["src/main/java/com/demo/shop/ShopController.java"]);
    expect(graph.imports.get("src/main/java/com/demo/shop/ShopService.java")).toEqual(["src/main/java/com/demo/util/Keys.java"]);
    // 直接导入与静态导入指向同一文件 → 合并成一条；`com.demo.util.*` 只到包名、无落点
    expect(graph.imports.get("src/main/java/com/demo/shop/ShopController.java")).toEqual(["src/main/java/com/demo/util/Keys.java"]);
    rmSync(join(javaFixture, ".tutor"), { recursive: true, force: true });
  });

  it("detects entrypoints from Spring annotations, boot class first with class-line anchors", () => {
    const index = indexRepository(javaFixture);
    const graph = buildDependencyGraph(javaFixture, index.files);
    expect(graph.entrypoints[0]).toEqual({ path: "src/main/java/com/demo/DemoApplication.java", line: 7, label: "Spring Boot 启动类" });
    expect(graph.entrypoints).toContainEqual({ path: "src/main/java/com/demo/shop/ShopController.java", line: 11, label: "HTTP 路由 (Spring MVC)：/shop" });
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
