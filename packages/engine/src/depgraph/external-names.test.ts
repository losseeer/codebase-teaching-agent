import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexRepository } from "../indexer/indexer.js";
import { buildDependencyGraph } from "./graph.js";
import { graphFromData, serializeGraph } from "./serialization.js";

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

/**
  `externals` 这个字段（架构视图的「系统边界之外」）。它一份边都不该多出来，
  所以下面每个用例都同时钉两件事：外部名记对了，以及 `imports` 一字未变——
  外部名一旦被当边连进图，影响范围、角色分层、流程证据全会跟着变，那就不是加一栏而是改图。
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
      // 身份切法见 `packageIdentity`：npm 取第一段、Python 取第一段、Java 取前四段、Go 域名式取前三段
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

  /**
    判据是「命中仓内包根就算断链」，不是「这条 import 能不能落到某个类」：
    `com.mycompany.shortlink` 这类项目自己的包根在边界之内，即便某个类当时不在索引里，
    把它报成「边界之外的依赖」也不准确。
  */
  it("命中项目自己的包根时不记外部名，即便那个类没被索引", async () =>
    await withRepo("externals-inrepo-root", {
      "src/com/mycompany/core/Widget.java": "package com.mycompany.core;\npublic class Widget {}\n",
      "src/com/mycompany/app/App.java": "package com.mycompany.app;\nimport com.mycompany.core.Widget;\nimport com.mycompany.core.Missing;\npublic class App { Widget w; Missing m; }\n"
    }, (dir) => {
      const graph = buildDependencyGraph(dir, indexRepository(dir).files);
      expect(graph.imports.get("src/com/mycompany/app/App.java"), "能落到的那条照常成边").toEqual(["src/com/mycompany/core/Widget.java"]);
      expect(graph.externals.has("src/com/mycompany/app/App.java"), "落不到的 `Missing` 是仓内断链，不是外部依赖").toBe(false);
    }));

  /**
    两类「解析不到」都不是外部包：仓内意图（相对路径 / 命中别名 / 工作区包）与脏捕获。
    `tsSpecifierPattern` 在 `.tsx` 里会抓到 `<div className=`、` | ` 这种根本不是模块名的串，
    只让落点返回 undefined 不够，名字要留档就必须先验形。
  */
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
      // 缺这个字段的产物读回来是空表而不是 undefined：调用方不用各自判空
      const legacy = graphFromData({ ...data, externals: undefined });
      expect(legacy.externals.size).toBe(0);
    }));

});
