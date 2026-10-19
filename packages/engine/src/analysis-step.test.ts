import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadedAnalysisStepCount } from "./analysis-steps.js";
import { ANALYSIS_STEP_LOCK_FILE, analysisSteps, readLockedFingerprints, stepFingerprints } from "./analysis-step.js";

/**
  口径登记的守卫：L2 缓存键只含口径版本号、不含提示词文本，改文案不翻版本时旧答案永久命中。
  本测试红只有两种出路，都要显式操作：该让旧产物作废就翻 `contractVersion` 再跑 `pnpm analysis:lock`；
  不值得作废（纯措辞润色）就直接跑 `pnpm analysis:lock` 并在 commit 里说明。
*/

/** 本目录（源码根）：扫描与清单比对都以它为基准，路径写法才和 `analysis-steps.ts` 里的导入一致。 */
const SRC_DIR = resolve(new URL(".", import.meta.url).pathname);

/** 清单模块里列出的副作用导入，形如 `./flows/flow.js`。 */
function barrelImports(): string[] {
  return (readFileSync(join(SRC_DIR, "analysis-steps.ts"), "utf8").match(/^import "\.\/[^"]+";/gm) ?? []).map((line) => line.slice(8, -2));
}

/** 扫出所有调用了 `defineAnalysisStep(` 的源码文件（排除登记模块自己与测试），返回 `./x/y.js` 形式。 */
function stepDefiningFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("analysis-step.ts") && readFileSync(path, "utf8").includes("defineAnalysisStep(")) found.push(`./${path.slice(SRC_DIR.length + 1).replace(/\.ts$/, ".js")}`);
    }
  };
  walk(SRC_DIR);
  return found.sort();
}

describe("口径登记的提示词指纹守卫", () => {
  it("登记不是可选动作：每个调用 defineAnalysisStep 的模块都被清单加载了", () => {
    expect(loadedAnalysisStepCount()).toBeGreaterThan(0);
    const listed = new Set(barrelImports());
    const missing = stepDefiningFiles().filter((module) => !listed.has(module));
    expect(missing, `这些模块登记了口径却没被 analysis-steps.ts 加载，指纹不会覆盖它们：${missing.join(", ")}`).toEqual([]);
  });

  it("每一层都交了提示词：空 prompts 等于把守卫关掉", () => {
    const empty = analysisSteps().filter((step) => !step.contractVersion || !step.promptDigest).map((step) => step.layer);
    expect(empty, `这些步骤没有版本号或指纹为空：${empty.join(", ")}`).toEqual([]);
  });

  it("层名唯一且非空（重名意味着两处给同一层算键）", () => {
    const layers = analysisSteps().map((step) => step.layer);
    expect(layers.filter((layer, index) => layers.indexOf(layer) !== index)).toEqual([]);
  });

  it("指纹与锁文件逐条相等：改了文案要么翻口径版本，要么显式跑 pnpm analysis:lock", () => {
    const locked = new Map(readLockedFingerprints().map((row) => [row.layer, row]));
    const current = stepFingerprints();
    const drift: string[] = [];
    for (const row of current) {
      const before = locked.get(row.layer);
      if (!before) {
        drift.push(`+ 新登记的层 ${row.layer}（${row.contractVersion}）：跑 pnpm analysis:lock 写进锁`);
        continue;
      }
      if (before.promptDigest !== row.promptDigest) drift.push(`~ ${row.layer}：提示词文案变了（指纹 ${before.promptDigest} → ${row.promptDigest}）。这条改动该让旧产物作废吗？该 ⇒ 先翻 contractVersion；不该 ⇒ 直接 pnpm analysis:lock 并在 commit 里说明`);
      if (before.contractVersion !== row.contractVersion) drift.push(`~ ${row.layer}：口径版本 ${before.contractVersion} → ${row.contractVersion}（这一翻会让旧产物全部作废，确认代价后 pnpm analysis:lock）`);
    }
    for (const layer of locked.keys()) if (!current.some((row) => row.layer === layer)) drift.push(`- 锁里还有 ${layer}，代码里已经没有这一步：确认它真的退役后 pnpm analysis:lock`);
    expect(drift, `口径与锁文件不一致：\n${drift.join("\n")}`).toEqual([]);
  });

  it("锁文件就是当前指纹的排序结果，不含登记顺序", () => {
    expect(readFileSync(ANALYSIS_STEP_LOCK_FILE, "utf8")).toBe(`${JSON.stringify(stepFingerprints(), null, 2)}\n`);
  });
});
