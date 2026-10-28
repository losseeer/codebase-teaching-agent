import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphExtensions } from "@codebase-tutor/analysis";
import { indexRepository, isIngestedPath, nonGraphExtensions, sourceExtensions } from "./indexer.js";

/**
  扫描期口径：单个文件读失败只让它自己缺席。
  缺席文件记名进 `unreadable`。
  */

describe("indexRepository 扫描期兜底", () => {
  const root = mkdtempSync(join(tmpdir(), "tutor-indexer-"));
  let unreadableAsRoot = false;

  beforeAll(() => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/ok.ts"), "export const ok = 1;\n", "utf8");
    writeFileSync(join(root, "src/gone.ts"), "export const gone = 1;\n", "utf8");
    chmodSync(join(root, "src/gone.ts"), 0o000);
    const index = indexRepository(root);
    unreadableAsRoot = index.files.some((file) => file.path === "src/gone.ts");
  });

  afterAll(() => {
    try {
      chmodSync(join(root, "src/gone.ts"), 0o644);
    } catch {
      // 文件可能已被下面的 rm 带走
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("读不到的文件被跳过并记名，导入照常产出其余文件", function run() {
    // macOS 下 root 无视权限位，此时 chmod 拦不住读，跳过本用例
    if (unreadableAsRoot) return;
    const index = indexRepository(root);
    expect(index.files.map((file) => file.path)).toEqual(["src/ok.ts"]);
    expect(index.totalFiles).toBe(1);
    expect(index.unreadable).toHaveLength(1);
    expect(index.unreadable?.[0]?.path).toBe("src/gone.ts");
    expect(index.unreadable?.[0]?.reason).toMatch(/EACCES|Permission|operation not permitted/i);
  });

  it("全都能读时不带 unreadable 这个键（旧索引的读数形状不受影响）", () => {
    const clean = mkdtempSync(join(tmpdir(), "tutor-indexer-clean-"));
    mkdirSync(join(clean, "src"), { recursive: true });
    writeFileSync(join(clean, "src/a.ts"), "export const a = 1;\n", "utf8");
    const index = indexRepository(clean);
    expect(index.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(Object.prototype.hasOwnProperty.call(index, "unreadable")).toBe(false);
    rmSync(clean, { recursive: true, force: true });
  });
});

/**
  扫描白名单的构成：索引范围 = graphExtensions ∪ nonGraphExtensions，前者由能力表派生。
  这里拦的是派生把范围改小、以及两组重叠。
*/
describe("indexRepository 的扩展名白名单构成", () => {
  it("图内与表外两组不重叠", () => {
    for (const extension of nonGraphExtensions) {
      expect([...graphExtensions], `${extension} 既在能力表又在 nonGraph，口径打架`).not.toContain(extension);
    }
  });

  it("并集等于实际扫描名单（没有第三处偷偷加/减扩展名）", () => {
    const union = [...new Set([...graphExtensions, ...nonGraphExtensions])].sort();
    expect([...sourceExtensions].sort(), "扫描名单与两组之和不一致：indexer 里藏了硬编码增删").toEqual(union);
  });

  it("收尾为派生之后，扫描范围不比旧的硬编码名单小（逐项核对，别静默缩小）", () => {
    const baselineBeforeDerivation = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".rb", ".php", ".vue", ".svelte", ".json", ".mod", ".md", ".yml", ".yaml"];
    for (const extension of baselineBeforeDerivation) {
      expect(sourceExtensions.has(extension), `${extension} 不再进索引：派生把扫描范围改小了`).toBe(true);
    }
  });

  /** 第二道闸：读层判「不开放读取」的密钥载体名不进收录集。 */
  it("密钥载体名不进收录集，普通配置文件照收（`.json` 这一类的两种命运）", () => {
    const dir = mkdtempSync(join(tmpdir(), "tutor-indexer-denied-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "credentials.json"), '{"aws_access_key_id":"AKIAEXAMPLESECRET"}\n', "utf8");
    writeFileSync(join(dir, "src/package.json"), '{"name":"demo"}\n', "utf8");
    writeFileSync(join(dir, "src/env.example"), "OPENAI_API_KEY=\n", "utf8");
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-not-indexed\n", "utf8");
    expect(indexRepository(dir).files.map((file) => file.path)).toEqual(["src/package.json"]);
    // `.example` 由扩展名白名单筛掉，不经名字闸
    expect(isIngestedPath("src/env.example"), ".example 是模板，扩展名本来就不收录").toBe(false);
    expect(isIngestedPath("credentials.json")).toBe(false);
    expect(isIngestedPath("deploy/credentials.json")).toBe(false);
    expect(isIngestedPath("src/app.ts")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
