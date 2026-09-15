import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph, impactRadius } from "./graph.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/frozen-demo-repo");
const tsFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/tsnext-demo-repo");

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
