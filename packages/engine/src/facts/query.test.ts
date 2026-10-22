import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { FileEntry, SymbolInfo } from "@codebase-tutor/shared";
import { repositoryId as deriveRepositoryId } from "../identity.js";
import { TutorDatabase } from "../store/database.js";
import { extractSymbolsFromAst, loadSymbolParser } from "../depgraph/parser.js";
import { collectFileFacts, saveFileFacts } from "./index.js";
import { FACTS_VERSION } from "./version.js";
import { factsQueryTool } from "./query.js";
import { factsToolFor } from "../application/canvas-tools.js";
import type { ImportedRepository } from "../importer/importer.js";

/**
  两个不能越的方向：
  - 「没算过」不能说成「仓库里没有」，模型会据此给出否定的结论；
  - 整份产物（含配置文件的值）不能原样吐出去：`.tutor` 是明文盘。
*/

const ALPHA = `export class Box {\n  size = 0;\n}\nexport function pick(a: number) {\n  if (a > 1) { return 1; }\n  return 0;\n}\n`;
const BETA = `import { Box } from "./alpha";\nexport class Lid extends Box {\n  open(): number {\n    const n = this.size + 1;\n    return n;\n  }\n}\n`;
const GAMMA = `const app = { use: (_p: string, _h: unknown) => undefined };\napp.use("/ping", () => undefined);\nexport function boot() {\n  return app;\n}\n`;
const YML = `spring:\n  datasource:\n    password: hunter2secret\n    url: jdbc:mysql://localhost/dianping\n`;

function entry(path: string, lines = 5): FileEntry {
  return { path, extension: path.slice(path.lastIndexOf(".")), bytes: 100, lines };
}

/** 真分析出来的小仓（不是手捏 payload），返回库、仓 id 与调用门的入口。 */
function fixture(): { root: string; db: TutorDatabase; id: string; call: (args: Record<string, string>) => string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "facts-query-")));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "src/main/resources"), { recursive: true });
  writeFileSync(join(root, "src/alpha.ts"), ALPHA);
  writeFileSync(join(root, "src/beta.ts"), BETA);
  writeFileSync(join(root, "src/gamma.ts"), GAMMA);
  writeFileSync(join(root, "src/main/resources/application.yml"), YML);
  const files = [entry("src/alpha.ts"), entry("src/beta.ts"), entry("src/gamma.ts"), entry("src/main/resources/application.yml")];
  const symbols: SymbolInfo[] = files.flatMap((file) => extractSymbolsFromAst(file.path, readFileSync(join(root, file.path), "utf8")) ?? []);
  const id = deriveRepositoryId(root);
  const db = new TutorDatabase(root);
  saveFileFacts(db, id, collectFileFacts(root, files, symbols));
  const tool = factsQueryTool(db, id);
  return { root, db, id, call: (args) => tool.apply(JSON.stringify(args)) };
}

describe("产物查询门", () => {
  beforeAll(async () => {
    await loadSymbolParser();
  });

  it("没有 kind 先给覆盖率清单：哪几类在册、各占多少文件、算于何时", () => {
    const f = fixture();
    try {
      const text = f.call({});
      for (const kind of ["cfg", "dataflow", "typeRelations", "registry"]) expect(text, kind).toContain(kind);
      expect(text).toContain("批次时间");
      expect(text).toContain("文件");
      expect(f.call({ kind: "cfg" })).toContain("给 path 取一个文件的读数");
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("cfg 两级读数：文件里列出函数与复杂度，点名函数才展开块与边", () => {
    const f = fixture();
    try {
      const list = f.call({ kind: "cfg", path: "src/alpha.ts" });
      expect(list).toContain("pick");
      expect(list).toContain("复杂度");
      const detail = f.call({ kind: "cfg", path: "src/alpha.ts", target: "pick" });
      expect(detail).toContain("块 0 entry");
      expect(detail).toContain("branch");
      expect(detail).toMatch(/边 \d+ → \d+（(true|false)）/);
      expect(f.call({ kind: "cfg", path: "src/alpha.ts", target: "nosuch" })).toContain("这个文件里没有名字含");
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("dataflow 展开到定义行与使用行，并单列读不到可达定义的那些", () => {
    const f = fixture();
    try {
      const list = f.call({ kind: "dataflow", path: "src/beta.ts" });
      expect(list).toContain("open");
      expect(list).toContain("变量");
      const detail = f.call({ kind: "dataflow", path: "src/beta.ts", target: "open" });
      expect(detail).toMatch(/n：定义 \d+/);
      expect(detail).toContain("读到");
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("类型关系按名字全仓找，落点直接给出文件（这是画架构图那条边要有出处的依据）", () => {
    const f = fixture();
    try {
      const byTarget = f.call({ kind: "typeRelations", target: "Lid" });
      expect(byTarget).toContain("extends");
      expect(byTarget).toContain("Box");
      expect(byTarget).toContain("src/alpha.ts");
      expect(f.call({ kind: "typeRelations", target: "Ghost" })).toContain("这不能证明关系不存在");
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("注册索引给条目与出处；配置文件的值一个字都不出去", () => {
    const f = fixture();
    try {
      const code = f.call({ kind: "registry", path: "src/gamma.ts" });
      expect(code).toContain("/ping");
      expect(code).toContain("app.use");
      const config = f.call({ kind: "registry", path: "src/main/resources/application.yml" });
      expect(config).toContain("spring.datasource.password");
      expect(config).not.toContain("hunter2secret");
      expect(config).not.toContain("jdbc:mysql");
      expect(f.call({ kind: "registry", target: "ping" })).toContain("src/gamma.ts");
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("「这类整批没算过」「这文件不在册」「算过但没图」是三个不同的读数", () => {
    const f = fixture();
    try {
      expect(f.call({ kind: "cfg", path: "src/missing.ts" })).toContain("这个文件不在其中");
      // 库里只有 cfg 一类：registry 一行都没有，门要说「先重新分析」而不是「没有条目」
      const partial = new TutorDatabase(f.root);
      const cfgOnly = collectFileFacts(f.root, [entry("src/alpha.ts")], extractSymbolsFromAst("src/alpha.ts", ALPHA) ?? []).filter((row) => row.kind === "cfg");
      const id2 = "repo_partial";
      saveFileFacts(partial, id2, cfgOnly);
      const text = factsQueryTool(partial, id2).apply(JSON.stringify({ kind: "registry", path: "src/gamma.ts" }));
      expect(text).toContain("本仓还没有 registry 这类产物");
      expect(text).toContain("不要据此回答");
      partial.close();
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("旧判据算出的行不当现行读数：按 path 取要说清是版本旧，「全仓找」那条路也不能漏出去", () => {
    const f = fixture();
    try {
      saveFileFacts(f.db, f.id, [{
        kind: "cfg",
        path: "legacy/old.ts",
        payload: { path: "legacy/old.ts", language: "typescript", backend: "ast", version: "facts-v1", functions: [{ symbolId: "symbol:legacy/old.ts:run:1", name: "run", kind: "function", startLine: 1, endLine: 2, blocks: [], edges: [], exitBlocks: [], complexity: 1 }] }
      }]);
      const tool = factsQueryTool(f.db, f.id);
      expect(tool.apply(JSON.stringify({ kind: "cfg", path: "legacy/old.ts" }))).toContain("旧判据算的");
      expect(tool.apply(JSON.stringify({ kind: "cfg", target: "run" }))).not.toContain("legacy/old.ts");
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("backend 为 none 的行照实把原因顶到第一行（空图与没判过在门这一层也分得开）", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "facts-none-")));
    const db = new TutorDatabase(root);
    const id = deriveRepositoryId(root);
    saveFileFacts(db, id, [{
      kind: "cfg",
      path: "legacy/tool.php",
      payload: { path: "legacy/tool.php", language: "php", backend: "none", version: FACTS_VERSION, functions: [], skipped: [{ name: "legacy/tool.php", reason: "引擎还没有 php 的控制流规则（语法树已解析，只是没有节点表）" }] }
    }]);
    try {
      const text = factsQueryTool(db, id).apply(JSON.stringify({ kind: "cfg", path: "legacy/tool.php" }));
      expect(text).toContain("backend none");
      expect(text).toContain("引擎还没有 php 的控制流规则");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("行预算来自窗口：小窗口下少列要声明「另有几条没列出」，宽窗口下全列出来", () => {
    const f = fixture();
    try {
      expect(f.call({ kind: "nope" })).toContain("只认");
      const many = Array.from({ length: 45 }, (_, index) => ({ symbolId: `symbol:bulk.ts:f${index}:1`, name: `f${index}`, kind: "function", startLine: index + 1, endLine: index + 2, blocks: [], edges: [], exitBlocks: [], complexity: 1 }));
      const id2 = "repo_bulk";
      saveFileFacts(f.db, id2, [{ kind: "cfg", path: "bulk.ts", payload: { path: "bulk.ts", language: "typescript", backend: "ast", version: FACTS_VERSION, functions: many } }]);
      const tool = factsQueryTool(f.db, id2);
      const listed = (text: string) => text.split("\n").filter((line) => /^f\d+@/.test(line)).length;

      // 窗口 8_000 token ⇒ 单次查询只有 1_600 字符 / 40 行的预算。少列几条不在断言里写死：
      // 那个数由表头与尾部提示占的行数决定，写死等于把份额抄进测试第二遍，改份额时只会红得莫名其妙。
      process.env.TUTOR_CONTEXT_WINDOW_TOKENS = "8000";
      const tight = tool.apply(JSON.stringify({ kind: "cfg", path: "bulk.ts" }));
      const omitted = Number(/另有 (\d+) 条没列出/.exec(tight)?.[1] ?? -1);
      expect(omitted, "小窗口下必然列不全，但少几条要如实声明").toBeGreaterThan(0);
      expect(listed(tight) + omitted).toBe(45);

      process.env.TUTOR_CONTEXT_WINDOW_TOKENS = "1000000";
      const wide = tool.apply(JSON.stringify({ kind: "cfg", path: "bulk.ts" }));
      expect(listed(wide), "窗口放到 1M 就不该再砍任何一条").toBe(45);
      expect(wide).not.toContain("没列出");
    } finally {
      delete process.env.TUTOR_CONTEXT_WINDOW_TOKENS;
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("盘上一行产物都没有时门照旧开着，且两个面都说实话", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "facts-empty-")));
    const db = new TutorDatabase(root);
    try {
      const repository = { index: { repositoryId: deriveRepositoryId(root) } } as unknown as ImportedRepository;
      const door = factsToolFor(repository, db);
      expect(door.inventory, "缺席要说成缺席，不能靠工具不在清单里让模型反推").toContain("本仓还没有静态产物");
      expect(door.apply(JSON.stringify({ kind: "cfg", path: "src/main.ts" }))).toContain("本仓还没有 cfg 这类产物");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
