import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { indexRepository } from "../indexer.js";
import { buildDependencyGraph } from "@codebase-tutor/analysis";
import { loadSymbolParser } from "@codebase-tutor/analysis";

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

describe("整仓自环与「每个文件一个源码根」", () => {
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it("约定名只认代码文件：docs/index.md 与 config/app.json 不是执行入口", async () =>
    await withRepo("doc-not-entry", {
      "docs/index.md": "# 说明\n",
      "config/app.json": "{}\n",
      "observability/main.yml": "a: 1\n",
      "src/main.ts": "export const m = 1;\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      // 入口清单会进 `classifyFileRoles`（入口文件直接算 core）与流程 digest：
      // 把一份 Markdown 当执行起点，流程就从一条不会自己跑的链路讲起
      expect(graph.entrypoints.map((anchor) => anchor.path)).toEqual(["src/main.ts"]);
      expect(indexRepository(dir).files.map((file) => file.path), "这三个文件确实进了索引").toEqual(expect.arrayContaining(["docs/index.md", "config/app.json", "observability/main.yml"]));
    }));

});
