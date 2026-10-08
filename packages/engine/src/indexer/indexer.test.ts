import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graphExtensions } from "../depgraph/graph.js";
import { indexRepository, nonGraphExtensions, sourceExtensions } from "./indexer.js";

/**
  扫描期的兜底口径（2026-10-06 复审 #123③）：**一个文件读不出来，只让它自己缺席**。
  旧写法是 `readFileSync` 裸奔——用户边用边改是常态，读到一半文件被删/被移动就让整次导入失败，
  而「重新导入」对那种文件治不好，等于把一次偶发抖动放大成整个功能不可用。
  但缺席必须**记名**：静默少索引一批文件，`totalFiles` 与「哪些文件没摘要」这些读数会一起说谎。
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
    // root 身份下 chmod 拦不住读（macOS 的 root 无视权限位），这台机器上这条测不出东西，直接跳过而不是假装通过
    if (unreadableAsRoot) return;
    const index = indexRepository(root);
    expect(index.files.map((file) => file.path)).toEqual(["src/ok.ts"]);
    expect(index.totalFiles).toBe(1);
    expect(index.unreadable).toHaveLength(1);
    expect(index.unreadable?.[0]?.path).toBe("src/gone.ts");
    // 原因要说得出口：只报「少了」等于让人去查一个查不到的东西
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
  扫描白名单的构成口径（indexer.ts 顶部那段注释承诺的三条核对）。索引范围 = graphExtensions ∪ nonGraphExtensions。
  graphExtensions 由能力表派生，所以这里真正要拦的不是「两边相不相等」（那是同义反复），而是派生别把范围改小、
  两组别打架：漏一项就少索引一类文件、后面的摘要与热点读数一起跟着说谎；重叠则说明同一扩展名既想进图又想当配置。
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

  it("收口为派生之后，扫描范围不比旧的硬编码名单小（逐项核对，别静默缩小）", () => {
    const baselineBeforeDerivation = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".rb", ".php", ".vue", ".svelte", ".json", ".mod", ".md", ".yml", ".yaml"];
    for (const extension of baselineBeforeDerivation) {
      expect(sourceExtensions.has(extension), `${extension} 不再进索引：派生把扫描范围改小了`).toBe(true);
    }
  });
});
