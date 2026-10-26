import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph } from "@codebase-tutor/analysis";

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

describe("说明符落点按发起文件的语言收尾", () => {
  it("TS 的 `./util` 不再连到同目录的 util.py / util.go / util.java", async () =>
    await withRepo("no-cross-language", {
      "src/a.ts": "import { x } from \"./util\";\nexport const a = x;\n",
      "src/util.py": "x = 1\n",
      "src/util.go": "package util\n",
      "src/util.java": "public class Util {}\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      // 落点只按发起文件所属语言的扩展名族试，不拿全表 19 个扩展名挨个试：
      // 挨个试会连到同名不同语言的 util.py，能力表给 typescript 的 dependencyEdge=exact 也就不成立。
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
