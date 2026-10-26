import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CELLS,
  CAPABILITY_LEVEL_LABEL,
  LANGUAGE_CAPABILITIES,
  UNKNOWN_LANGUAGE_CAPABILITIES,
  languageCapabilitiesOf,
  languageOfExtension,
  type CapabilityLevel
} from "./language-capabilities.js";
import type { FileEntry } from "./repository-index.js";

/**
  语言能力表的回归。要拦的事故有三个：
  1. 表漂移：引擎加了/去了一个扩展名的支持，表没跟着改——读数以表为准，漂了就等于误导人。
  2. 空档：某门语言的某个节点没填（或填了个自造的档），界面会把「没说」显示成「没问题」。
  3. 抬高：把没有规则的节点写成 `approximate` 装「大概能行」。
*/

const LEVELS: CapabilityLevel[] = ["exact", "approximate", "unsupported"];

function file(path: string, lines = 1): FileEntry {
  const extension = path.slice(path.lastIndexOf("."));
  return { path, extension, bytes: 10, lines };
}

describe("语言能力表：每个节点都要有明确取值", () => {
  it("每门已支持语言的九个字段都取三档之一，且每个节点都配了一句白话说明", () => {
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
    // 三种写法同一档：扩展名、带点的扩展名、完整路径、大写
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

