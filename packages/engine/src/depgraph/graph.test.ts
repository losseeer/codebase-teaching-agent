import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph, impactRadius } from "./graph.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/frozen-demo-repo");

describe("dependency graph v1", () => {
  it("returns callers in the impact radius of a changed imported file", () => {
    const index = indexRepository(fixture);
    const graph = buildDependencyGraph(fixture, index.files);
    const impact = impactRadius(graph, ["src/config.js"]);
    expect(impact.impactedPaths).toContain("src/config.js");
    expect(impact.impactedPaths).toContain("src/main.js");
    expect(impact.edges).toContainEqual(expect.objectContaining({ from: "src/main.js", to: "src/config.js", kind: "import" }));
  });
});
