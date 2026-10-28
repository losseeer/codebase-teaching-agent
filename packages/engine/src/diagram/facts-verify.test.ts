import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DeclaredType, RegistryEntry, RegistryFileFact, TypeRelationFileFact } from "@codebase-tutor/domain";

import { TutorDatabase } from "../adapter/outbound/persistence/database.js";
import { factsPairChecker, type FactSources } from "./facts-verify.js";

/** 证据表用例：类型关系与运行时绑定能确认哪些画布边、哪些不能。 */

const REPO = "repo_facts_verify";

type Row = { kind: "typeRelations"; path: string; payload: TypeRelationFileFact } | { kind: "registry"; path: string; payload: RegistryFileFact };

const types = (path: string, declared: DeclaredType[]): Row => ({
  kind: "typeRelations",
  path,
  payload: { path, language: "java", backend: "ast", version: "test", types: declared }
});

const registry = (path: string, entries: RegistryEntry[]): Row => ({
  kind: "registry",
  path,
  payload: { path, language: "java", backend: "ast", version: "test", entries }
});

/** 每个用例一套现场：把产物写进临时库，并给出取行的通道。 */
function seeded(rows: Row[]): { db: TutorDatabase; root: string; sources: FactSources } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "facts-verify-")));
  mkdirSync(join(root, "case"), { recursive: true });
  const db = new TutorDatabase(root);
  for (const row of rows) db.facts.save(REPO, row.kind, [{ path: row.path, payload: row.payload }]);
  return {
    db,
    root,
    sources: {
      typeRelations: () => db.facts.listByKind<TypeRelationFileFact>(REPO, "typeRelations"),
      registry: () => db.facts.listByKind<RegistryFileFact>(REPO, "registry")
    }
  };
}

describe("画布边校验的第四张表", () => {
  it("类型关系落点查得到的那一条能给证据；方向反过来不算", () => {
    const f = seeded([
      types("src/OrderServiceImpl.java", [{ name: "OrderServiceImpl", kind: "class", line: 3, endLine: 40, relations: [{ to: "OrderService", kind: "implements", via: "implements 子句", line: 3, toFile: "src/OrderService.java" }] }])
    ]);
    try {
      const check = factsPairChecker(f.sources);
      const hit = check(["src/OrderServiceImpl.java"], ["src/OrderService.java"]);
      expect(hit?.origin).toBe("static");
      expect(hit?.detail).toContain("implements");
      expect(hit?.detail).toContain("src/OrderService.java:3");
      expect(check(["src/OrderService.java"], ["src/OrderServiceImpl.java"]), "接口不依赖实现：反方向不能也给证据").toBeUndefined();
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("反查不到落点（仓外类型）与同名多解都不算证据", () => {
    const f = seeded([
      types("src/A.ts", [
        { name: "A", kind: "class", line: 1, endLine: 9, relations: [{ to: "Date", kind: "field", via: "字段类型标注", line: 2 }] },
        { name: "B", kind: "class", line: 4, endLine: 9, relations: [{ to: "Box", kind: "extends", via: "extends 子句", line: 4, ambiguous: ["src/one/Box.ts", "src/two/Box.ts"] }] }
      ])
    ]);
    try {
      const check = factsPairChecker(f.sources);
      expect(check(["src/A.ts"], ["src/other.ts"])).toBeUndefined();
      expect(check(["src/A.ts"], ["src/one/Box.ts"]), "同名多解时引擎不替读者挑一个落点，所以也就不给这条证据").toBeUndefined();
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("注入点指向接口声明文件：这是 import 图里没有、但确实存在的一条运行时关系", () => {
    const f = seeded([
      types("src/OrderService.java", [{ name: "OrderService", kind: "interface", line: 1, endLine: 6, relations: [] }]),
      registry("src/OrderController.java", [{ kind: "di-binding", name: "OrderService", via: "构造注入", line: 7 }])
    ]);
    try {
      const check = factsPairChecker(f.sources);
      const hit = check(["src/OrderController.java"], ["src/OrderService.java"]);
      expect(hit?.detail, "依据要写得出让用户看得出这不是猜的").toContain("注入 OrderService");
      expect(check(["src/OrderController.java"], ["src/Unrelated.java"])).toBeUndefined();
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("注册条目里写了实现（AddScoped<接口, 实现>）时，落点是实现声明所在的那个文件", () => {
    const f = seeded([
      types("src/impl/RedisCache.cs", [{ name: "RedisCache", kind: "class", line: 2, endLine: 30, relations: [] }]),
      registry("src/Program.cs", [{ kind: "di-binding", name: "ICache", target: "RedisCache", via: "AddScoped 注册", line: 9 }]),
      types("src/ICache.cs", [{ name: "ICache", kind: "interface", line: 1, endLine: 4, relations: [] }])
    ]);
    try {
      expect(factsPairChecker(f.sources)(["src/Program.cs"], ["src/impl/RedisCache.cs"])?.detail).toContain("ICache → RedisCache");
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("盘上没有产物时这张表就是空的（行为与加它之前逐字一致）", () => {
    const f = seeded([]);
    try {
      expect(factsPairChecker(f.sources)(["src/a.ts"], ["src/b.ts"])).toBeUndefined();
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
