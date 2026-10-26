import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
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
