import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepository } from "../indexer.js";
import { buildDependencyGraph } from "@codebase-tutor/analysis";
import { graphFromData, serializeGraph } from "@codebase-tutor/analysis";

/** 在临时目录里按 fileMap 造一个小仓库。 */
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

/**
  externals 只记外部包名，不产生边。
  每个用例同时断言外部名与 imports 的边集合。
*/
describe("外部包名采集（留名不留边）", () => {
  it("四种语言各自采到裸包名，且一条边都不许多", async () =>
    await withRepo("externals-basic", {
      "src/app.ts": 'import { render } from "react-dom";\nimport axios from "axios";\nimport { helper } from "./helper";\nexport const a = [render, axios, helper];\n',
      "src/helper.ts": "export const helper = 1;\n",
      "app/main.py": "import flask\nfrom redis.clients import Redis\nfrom . import util\nprint(flask, Redis, util)\n",
      "app/util.py": "X = 1\n",
      "src/Main.java": "import com.fasterxml.jackson.databind.ObjectMapper;\npublic class Main { ObjectMapper m; }\n",
      "cmd/main.go": "package main\n\nimport (\n\t\"fmt\"\n\t\"github.com/gin-gonic/gin\"\n)\n\nfunc main() { fmt.Println(gin.Version) }\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      // 包名切法见 packageIdentity。
      expect(graph.externals.get("src/app.ts")).toEqual(["axios", "react-dom"]);
      expect(graph.externals.get("app/main.py")).toEqual(["flask", "redis"]);
      expect(graph.externals.get("src/Main.java")).toEqual(["com.fasterxml.jackson.databind"]);
      expect(graph.externals.get("cmd/main.go"), "Go 域名式身份取前三段，正好是模块路径本身").toEqual(["fmt", "github.com/gin-gonic/gin"]);
      expect(graph.imports.get("src/app.ts"), "外部名不进边").toEqual(["src/helper.ts"]);
      expect(graph.imports.get("app/main.py"), "`from . import util` 是仓内相对导入").toEqual(["app/util.py"]);
      expect(graph.imports.get("src/Main.java"), "Jackson 落不到仓内文件，就没有这条边").toEqual([]);
      expect(graph.imports.get("cmd/main.go")).toEqual([]);
      expect([...graph.externals.keys()].sort(), "没有外部名的文件不写键").toEqual(["app/main.py", "cmd/main.go", "src/Main.java", "src/app.ts"]);
    }));

  // 命中仓内包根即算断链，不看单个类是否在索引里。
  it("命中项目自己的包根时不记外部名，即便那个类没被索引", async () =>
    await withRepo("externals-inrepo-root", {
      "src/com/mycompany/core/Widget.java": "package com.mycompany.core;\npublic class Widget {}\n",
      "src/com/mycompany/app/App.java": "package com.mycompany.app;\nimport com.mycompany.core.Widget;\nimport com.mycompany.core.Missing;\npublic class App { Widget w; Missing m; }\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      expect(graph.imports.get("src/com/mycompany/app/App.java"), "能落到的那条照常成边").toEqual(["src/com/mycompany/core/Widget.java"]);
      expect(graph.externals.has("src/com/mycompany/app/App.java"), "落不到的 `Missing` 是仓内断链，不是外部依赖").toBe(false);
    }));

  // 仓内意图与脏捕获都不记外部名；外部名要先过包名字形校验。
  it("相对路径、别名与工作区包不算外部；不是包名字形的脏捕获也不记", async () =>
    await withRepo("externals-shape", {
      "package.json": '{ "name": "fixture", "workspaces": ["packages/*"] }\n',
      "packages/kit/package.json": '{ "name": "@kit/core", "main": "index.ts" }\n',
      "packages/kit/index.ts": "export const kit = 1;\n",
      "src/a.ts": 'import { kit } from "@kit/core";\nimport { gone } from "./missing";\nconst noise = 0; // from " | "\nexport { kit, gone, noise };\n'
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      expect(graph.imports.get("src/a.ts"), "工作区包照常成边").toEqual(["packages/kit/index.ts"]);
      expect(graph.externals.has("src/a.ts"), "落不到的 ./missing 是仓内断链；` | ` 不是包名；@kit/core 已经落到边").toBe(false);
    }));

  it("externals 走一遍序列化往返：旧产物缺这个字段时按未采集处理，不硬造", async () =>
    await withRepo("externals-roundtrip", {
      "src/a.ts": 'import axios from "axios";\nexport const a = axios;\n'
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      const data = serializeGraph(graph);
      expect(data.externals).toEqual({ "src/a.ts": ["axios"] });
      const back = graphFromData(data);
      expect(back.externals.get("src/a.ts")).toEqual(["axios"]);
      // 缺 externals 字段的产物读回来是空表。
      const legacy = graphFromData({ ...data, externals: undefined });
      expect(legacy.externals.size).toBe(0);
    }));

});
