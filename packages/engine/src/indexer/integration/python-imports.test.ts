import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepository } from "../indexer.js";
import { buildDependencyGraph } from "@codebase-tutor/analysis";

const pyFixture = join(dirname(fileURLToPath(import.meta.url)), "../../../../../test-fixtures/pydemo-repo");

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
