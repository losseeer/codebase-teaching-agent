import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph } from "./graph.js";
import { loadSymbolParser } from "./parser.js";

const javaFixture = join(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/javademo-repo");

describe("dependency graph — Java/Spring", () => {
  // Java 的符号只来自语法树（回落档不认 Java），不加载解析器就没有任何调用边
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it("detects entrypoints from Spring annotations, boot class first with class-line anchors", () => {
    const index = indexRepository(javaFixture);
    const graph = buildDependencyGraph(javaFixture, index.files);
    expect(graph.entrypoints[0]).toEqual({ path: "src/main/java/com/demo/DemoApplication.java", line: 7, label: "Spring Boot 启动类" });
    expect(graph.entrypoints).toContainEqual({ path: "src/main/java/com/demo/shop/ShopController.java", line: 12, label: "HTTP 路由 (Spring MVC)：/shop" });
    rmSync(join(javaFixture, ".tutor"), { recursive: true, force: true });
  });

});
