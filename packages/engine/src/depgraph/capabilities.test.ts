import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CELLS,
  CAPABILITY_LEVEL_LABEL,
  LANGUAGE_BY_EXTENSION,
  LANGUAGE_CAPABILITIES,
  UNKNOWN_LANGUAGE_CAPABILITIES,
  languageCapabilitiesOf,
  languageOfExtension,
  type CapabilityLevel,
  type FileEntry
} from "@codebase-tutor/shared";
import { languageProfileOf } from "./language-profile.js";

/**
  语言能力表的回归。要拦的事故有三个：
  1. **表漂移**：引擎加了/去了一个扩展名的支持，表没跟着改——读数以表为准，漂了就等于在骗人。
  2. **空档**：某门语言某一格没填（或填了个自造的档），界面就会把「没说」显示成「没问题」。
  3. **抬高**：把没规则的格子写成 `approximate` 装「大概能行」，等于回到「假装支持」的老毛病。

  基准是 `graph.ts` 里那条 `extensions` 清单。测试**读它的源码**而不是让它导出：
  那张清单是建图输入，动一行就要重跑图（正有人在那儿改 Java 入口规则），读侧拿不到就别碰实现。
*/

const LEVELS: CapabilityLevel[] = ["exact", "approximate", "unsupported"];
const graphSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "graph.ts"), "utf8");

/** `DependencyGraph` 实际处理的扩展名（graph.ts 顶部那条私有清单）。 */
function extensionsHandledByGraph(): string[] {
  const declaration = graphSource.match(/^const extensions = \[([^\]]*)\];/m);
  expect(declaration, "graph.ts 的扩展名清单形状变了，这里的比对口径要跟着改").toBeTruthy();
  return [...declaration![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function file(path: string, lines = 1): FileEntry {
  const extension = path.slice(path.lastIndexOf("."));
  return { path, extension, bytes: 10, lines };
}

describe("语言能力表：每格都要有明确取值", () => {
  it("每门已支持语言的五格都取三档之一，且每格都配了一句白话说明", () => {
    for (const [language, entry] of Object.entries(LANGUAGE_CAPABILITIES)) {
      expect(entry.language, `${language}：language 要与表键一致`).toBe(language);
      expect(entry.displayName, `${language}：界面要中文名`).toBeTruthy();
      expect(entry.extensions.length, `${language}：至少一个扩展名`).toBeGreaterThan(0);
      for (const cell of CAPABILITY_CELLS) {
        expect(LEVELS, `${language}.${cell} 的取值不在三档内`).toContain(entry.cells[cell]);
        expect(entry.notes[cell], `${language}.${cell} 缺说明`).toBeTruthy();
      }
    }
    // 三档都要有中文名，否则界面出现「未定义」
    expect(Object.keys(CAPABILITY_LEVEL_LABEL).sort()).toEqual([...LEVELS].sort());
  });

  it("已知写法能查到；未知语言回落 unsupported，不假装是 approximate", () => {
    // 三种写法同一档：扩展名、带点的扩展名、完整路径
    for (const spelling of [".java", "java", "src/main/Order.java", "JAVA"]) {
      expect(languageCapabilitiesOf(spelling).language, spelling).toBe("java");
    }
    expect(languageOfExtension(".vue")).toBe("vue");
    expect(languageCapabilitiesOf("main.rs").cells.entrypoint).toBe("exact");

    for (const unknown of [".rb", ".php", ".svelte", ".md", "zig", "kotlin", "", "   ", ".constructor", "toString", "hasOwnProperty"]) {
      const capabilities = languageCapabilitiesOf(unknown);
      expect(capabilities.language, `${unknown} 应算未知语言`).toBe("unknown");
      for (const cell of CAPABILITY_CELLS) {
        expect(capabilities.cells[cell], `${unknown} 的 ${cell} 不许抬高`).toBe("unsupported");
      }
    }
    expect(UNKNOWN_LANGUAGE_CAPABILITIES.cells.dependencyEdge).toBe("unsupported");
  });
});

describe("语言能力表：与依赖图的实际支持清单不漂移", () => {
  it("表里声明的扩展名 == graph.ts 实际处理的扩展名（双向全等）", () => {
    const handled = new Set(extensionsHandledByGraph());
    const declared = new Set(Object.keys(LANGUAGE_BY_EXTENSION));
    expect([...declared].sort(), "语言表多了引擎其实不处理的扩展名（等于假装支持）").toEqual([...handled].sort());
    expect([...handled].sort(), "引擎支持但语言表漏了一门——补语言时要一起改表").toEqual([...declared].sort());
  });

  it("每个扩展名都查得到它所属的那门语言（汇总口径与逐语言声明一致）", () => {
    for (const [extension, language] of Object.entries(LANGUAGE_BY_EXTENSION)) {
      expect(languageCapabilitiesOf(extension).language, extension).toBe(language);
      expect(LANGUAGE_CAPABILITIES[language].extensions, `${extension} 没列在 ${language} 名下`).toContain(extension);
    }
  });

  it("索引器会收录但依赖图不处理的扩展名，查出来是 unsupported（而不是含糊的近似）", () => {
    // 这几门是实测存在的坑：文件进了索引与目录树，但一条边都不会有
    for (const extension of [".rb", ".php", ".svelte"]) {
      expect(extensionsHandledByGraph(), extension).not.toContain(extension);
      expect(languageCapabilitiesOf(`${extension}`).cells.dependencyEdge).toBe("unsupported");
    }
  });
});

describe("语言画像（只读现算，不参与任何缓存键）", () => {
  const graph = { parseBackend: "ast" as const };

  it("按语言归堆、给出占比，未进图的语言单独成行", () => {
    const profile = languageProfileOf([
      file("src/Order.java", 30),
      file("src/Items.java", 10),
      file("src/main.ts", 5),
      file("README.md", 100)
    ], graph);

    const java = profile.languages.find((row) => row.language === "java");
    expect(java).toBeDefined();
    expect(java!.files).toBe(2);
    expect(java!.lines).toBe(40);
    expect(java!.inDependencyGraph).toBe(true);
    // 排序按文件数：Java 2 > TS 1 > Markdown 1（同数按名字）
    expect(profile.languages[0].language).toBe("java");
    expect(profile.graphFileShare).toBe(0.75);

    const markdown = profile.languages.find((row) => row.displayName === ".md 文件");
    expect(markdown, "Markdown 要如实标成「没进依赖图」").toBeDefined();
    expect(markdown!.inDependencyGraph).toBe(false);
    expect(markdown!.capabilities.cells.dependencyEdge).toBe("unsupported");
  });

  it("主语言的依赖边档能直接被界面读到（近似语言不许被显示成可信）", () => {
    const profile = languageProfileOf([file("cmd/main.go"), file("a.go")], graph);
    const go = profile.languages.find((row) => row.language === "go")!;
    expect(go.capabilities.cells.dependencyEdge).toBe("approximate");
    expect(go.capabilities.cells.entrypoint).toBe("exact");
    expect(profile.graphFileShare).toBe(1);
  });

  it("旧产物没有 parseBackend 时按 regex 认，与 graphFromData 同口径（不假装是语法树结果）", () => {
    const profile = languageProfileOf([file("src/main.ts")], {});
    expect(profile.parseBackend).toBe("regex");
    expect(profile.parseBackendReason).toBeUndefined();
    const withReason = languageProfileOf([file("src/main.ts")], { parseBackend: "regex", parseBackendReason: "语法解析器加载失败" });
    expect(withReason.parseBackendReason).toBe("语法解析器加载失败");
  });

  it("空仓库不炸：分布为空、占比 0", () => {
    expect(languageProfileOf([], graph)).toMatchObject({ languages: [], graphFileShare: 0, parseBackend: "ast" });
  });
});
