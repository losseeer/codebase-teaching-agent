import { beforeAll, describe, expect, it } from "vitest";
import { LANGUAGE_BY_EXTENSION, LANGUAGE_CAPABILITIES, languageCapabilitiesOf, type CapabilityLevel } from "@codebase-tutor/domain";

import { graphExtensions } from "@codebase-tutor/analysis";
import { loadSymbolParser } from "@codebase-tutor/analysis";
import { buildFileCfg } from "@codebase-tutor/analysis";

/**
  语言能力表的回归，拦三类事故：表与引擎实际支持漂移、节点留空或自造档、把没有规则写成 `approximate`。
  基准是 `graph.ts` 导出的 `graphExtensions`，它由本表派生。
  检查两件：派生没漏项、范围不因派生而缩小。
*/

// 探测产物层要先加载解析器，未加载时每个扩展名都读出 backend none
beforeAll(async () => {
  await loadSymbolParser();
});

function extensionsHandledByGraph(): string[] {
  return [...graphExtensions];
}

describe("语言能力表：每个节点都要有明确取值", () => {
  it("产物层那四格不许超过语法树的实际覆盖：controlFlow 与「这个扩展名真能出图」必须同进同退", () => {
    // 表与实际覆盖必须同进同退：表说有而节点表没有，读侧会把空白当成「算过是空的」
    // 空内容即可探：spec 缺失返回 backend none，spec 在则空文件返回 ast
    const claimsCoverage = (level: CapabilityLevel): boolean => level !== "unsupported";
    for (const [language, entry] of Object.entries(LANGUAGE_CAPABILITIES)) {
      for (const extension of entry.extensions) {
        const supported = buildFileCfg(`probe${extension}`, "", [], language).backend === "ast";
        const level: CapabilityLevel = entry.cells.controlFlow;
        expect(claimsCoverage(level), `${language}${extension}：表说${level}，实际${supported ? "出得了图" : "出不了图"}`).toBe(supported);
      }
    }
  });
});

describe("语言能力表：与依赖图的实际支持清单不漂移", () => {
  it("派生自表的 graphExtensions 不得因改表而缩小：收尾前那份手写清单的每一项都还得在", () => {
    // 不与 LANGUAGE_BY_EXTENSION 互相比对：两者同源于这张表
    // 对着下面这份独立快照核对：表被改小、依赖图静默少覆盖时这条红
    const handled = [...extensionsHandledByGraph()];
    const baselineBeforeDerivation = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rs", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".vue"];
    for (const extension of baselineBeforeDerivation) {
      expect(handled, `依赖图不再处理 ${extension}：能力表被改小了，图会静默少掉这门语言的边`).toContain(extension);
    }
  });

  it("每个扩展名都查得到它所属的那门语言（汇总口径与逐语言声明一致）", () => {
    for (const [extension, language] of Object.entries(LANGUAGE_BY_EXTENSION)) {
      expect(languageCapabilitiesOf(extension).language, extension).toBe(language);
      expect(LANGUAGE_CAPABILITIES[language].extensions, `${extension} 没列在 ${language} 名下`).toContain(extension);
    }
  });

  it("索引器会收录但依赖图不处理的扩展名，查出来是 unsupported（而不是含糊的近似）", () => {
    // 这些语言的文件进了索引与目录树，但一条边都不会有
    for (const extension of [".rb", ".php", ".svelte"]) {
      expect(extensionsHandledByGraph(), extension).not.toContain(extension);
      expect(languageCapabilitiesOf(`${extension}`).cells.dependencyEdge).toBe("unsupported");
    }
  });
});

