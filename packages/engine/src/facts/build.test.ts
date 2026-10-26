import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CfgFileFact, FileEntry, SymbolInfo, TypeRelationFileFact } from "@codebase-tutor/domain";

import { repositoryId as deriveRepositoryId } from "@codebase-tutor/platform";
import { TutorDatabase } from "../store/database.js";
import { extractSymbolsFromAst, loadSymbolParser } from "@codebase-tutor/analysis";
import { collectFileFacts, saveFileFacts } from "./build.js";
import { FACTS_VERSION } from "@codebase-tutor/analysis";

/**
  这里验接线，图算得对不对由 `cfg.test.ts` 管：
  算出来的东西真进了 `static_fact`、按文件一行、文件消失后不留旧行。
*/

beforeAll(async () => {
  await loadSymbolParser();
});

function entry(path: string, lines: number): FileEntry {
  return { path, extension: path.slice(path.lastIndexOf(".")), bytes: 100, lines };
}

function symbolsOf(path: string, content: string): SymbolInfo[] {
  return extractSymbolsFromAst(path, content) ?? [];
}

describe("静态产物落库", () => {
  it("按文件一行存进去、读得回来，覆盖率读数把「没做过」与「都算过」分开", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "facts-")));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const alpha = `export class Box {\n  size = 0;\n}\nexport function pick(a: number) {\n  if (a > 1) { return 1; }\n  return 0;\n}\n`;
      const beta = `export function flat(a: number) {\n  return a + 1;\n}\n`;
      writeFileSync(join(root, "src", "alpha.ts"), alpha);
      const alphaSymbols = symbolsOf("src/alpha.ts", alpha);
      writeFileSync(join(root, "src", "beta.ts"), beta);
      const repositoryId = deriveRepositoryId(root);
      const files = [entry("src/alpha.ts", 7), entry("src/beta.ts", 3)];
      const symbols = [...alphaSymbols, ...symbolsOf("src/beta.ts", beta)];

      const db = new TutorDatabase(root);
      saveFileFacts(db, repositoryId, collectFileFacts(root, files, symbols));
      const facts = db.listFileFacts<CfgFileFact>(repositoryId, "cfg");
      expect([...facts.keys()]).toEqual(["src/alpha.ts", "src/beta.ts"]);
      expect(facts.get("src/alpha.ts")?.functions[0]?.blocks.map((block) => block.kind)).toEqual(["entry", "branch", "straight", "straight", "exit", "exit"]);
      expect(facts.get("src/beta.ts")?.functions[0]?.blocks.map((block) => block.kind)).toEqual(["entry", "exit"]);
      expect(facts.get("src/alpha.ts")?.version).toBe(FACTS_VERSION);
      const coverage = db.factCoverage(repositoryId);
      expect(coverage.find((row) => row.kind === "cfg")?.files).toBe(2);
      expect(coverage.find((row) => row.kind === "dataflow")?.files, "一次解析要同时产出各类产物").toBe(2);
      expect(coverage.find((row) => row.kind === "typeRelations")?.files).toBe(2);
      // 没算过的类别不报行，读侧据此说「这项没有」，而不是拿 0 个文件冒充「都算过、都是空」
      expect(coverage.map((row) => row.kind).sort()).toEqual(["cfg", "dataflow", "registry", "typeRelations"]);
      const typed = db.getFileFact<TypeRelationFileFact>(repositoryId, "typeRelations", "src/alpha.ts");
      expect(typed?.types.map((item) => item.name)).toEqual(["Box"]);
      expect(typed?.types[0]?.kind).toBe("class");
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("整批替换后，已从索引消失的文件不留旧行", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "facts-prune-")));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const code = `export function one(a: number) { return a; }\n`;
      writeFileSync(join(root, "src", "one.ts"), code);
      writeFileSync(join(root, "src", "two.ts"), code);
      const repositoryId = deriveRepositoryId(root);
      const symbols = [...symbolsOf("src/one.ts", code), ...symbolsOf("src/two.ts", code)];
      const db = new TutorDatabase(root);
      saveFileFacts(db, repositoryId, collectFileFacts(root, [entry("src/one.ts", 1), entry("src/two.ts", 1)], symbols));
      expect(db.getFileFact<CfgFileFact>(repositoryId, "cfg", "src/two.ts")?.backend).toBe("ast");
      saveFileFacts(db, repositoryId, collectFileFacts(root, [entry("src/one.ts", 1)], symbolsOf("src/one.ts", code)));
      expect(db.getFileFact(repositoryId, "cfg", "src/two.ts")).toBeUndefined();
      expect(db.factCoverage(repositoryId).find((row) => row.kind === "cfg")?.files).toBe(1);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("扫描期就读不到的文件不产行，也不报错（它在索引层已经记过名）", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "facts-missing-")));
    try {
      const repositoryId = deriveRepositoryId(root);
      const db = new TutorDatabase(root);
      const rows = collectFileFacts(root, [entry("src/gone.ts", 5)], [{ id: "symbol:src/gone.ts:gone:1", name: "gone", kind: "function", path: "src/gone.ts", line: 1, endLine: 5, parameters: [], language: "typescript" }]);
      expect(rows).toEqual([]);
      saveFileFacts(db, repositoryId, rows);
      expect(db.factCoverage(repositoryId)).toEqual([]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
