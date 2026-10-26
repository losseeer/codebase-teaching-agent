import { beforeAll, describe, expect, it } from "vitest";
import { LANGUAGE_BY_EXTENSION, LANGUAGE_CAPABILITIES, languageCapabilitiesOf, type CapabilityLevel } from "@codebase-tutor/domain";

import { graphExtensions } from "@codebase-tutor/analysis";
import { loadSymbolParser } from "@codebase-tutor/analysis";
import { buildFileCfg } from "@codebase-tutor/analysis";

/**
  语言能力表的回归。要拦的事故有三个：
  1. 表漂移：引擎加了/去了一个扩展名的支持，表没跟着改——读数以表为准，漂了就等于误导人。
  2. 空档：某门语言的某个节点没填（或填了个自造的档），界面会把「没说」显示成「没问题」。
  3. 抬高：把没有规则的节点写成 `approximate` 装「大概能行」。

  基准是 `graph.ts` 导出的 `graphExtensions`，它由本表派生，清单只有一个来源，
  因此这里的检查只剩两件：派生没漏项（有人把清单写回硬编码就会红），以及索引范围不因派生而缩小。
*/

// 产物层那一格要拿语法树探，解析器得先起来（没起来时每个扩展名都读出 backend none，整条会假红）
beforeAll(async () => {
  await loadSymbolParser();
});

/** `DependencyGraph` 实际处理的扩展名，取自表派生出来的那一份清单。 */
function extensionsHandledByGraph(): string[] {
  return [...graphExtensions];
}

describe("语言能力表：每个节点都要有明确取值", () => {
  it("产物层那四格不许超过语法树的实际覆盖：controlFlow 与「这个扩展名真能出图」必须同进同退", () => {
    // 表说某语言有控制流图，而 `facts/cfg.ts` 的节点表里没有它 ⇒ 读侧会拿到一片空白却以为是「算过是空的」。
    // 反向也要成立：加了节点表却忘了改表，就是把能算的东西说成不能算。
    // 空内容即可探：spec 缺失直接返回 backend none，spec 在则空文件也解析得动，返回 ast。
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
    // 不与 LANGUAGE_BY_EXTENSION 互相比对：两者都由 LANGUAGE_CAPABILITIES 派生，恒等、永远绿。
    // 这里对着下面那份独立快照核对：有人从表里删了一门语言或漏写一个扩展名，依赖图会静默失去覆盖，这条会红。
    // 新增语言不必动这里；只有「缩小」才该红。
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
