import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph, impactRadius } from "./graph.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/frozen-demo-repo");
const tsFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/tsnext-demo-repo");
const pyFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/pydemo-repo");

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
