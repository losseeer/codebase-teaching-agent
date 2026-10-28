import { extname } from "node:path";
import { LANGUAGE_CAPABILITIES, languageOfExtension } from "@codebase-tutor/domain";

/** 图认的扩展名，汇总自能力表各条目的 `extensions`。 */
export const graphExtensions: readonly string[] = [...new Set(Object.values(LANGUAGE_CAPABILITIES).flatMap((entry) => entry.extensions))];
/**
  建图时的后缀闸门（`buildDependencyGraph` 与语言画像共用），区分大小写。
  与索引层闸门不同一条：索引器先转小写，`App.TS` 进得了索引清单、进不了图。
*/
export const handledExtensions = new Set(graphExtensions);

/**
  裸说明符的落点扩展名按发起文件语言收尾，不用全表逐个试。
  typescript 与 vue 一族互连，其余语言各自只试自己的扩展名。
*/
const SCRIPT_FAMILY = ["typescript", "vue"] as const;

/** ES/CJS/JSX 后缀对应的 TS 源文件后缀，NodeNext 约定。 */
export const nodeNextTargets: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts", ".d.mts"],
  ".cjs": [".cts", ".d.cts"]
};

/**
  「按 TS 一族写法处理」的判据，取自能力表。
  这一族不含 `.vue`：`.vue` 的回落符号标 `other`，也不给它探 TS 语言服务。
*/
export const tsFamilyExtensions = new Set(LANGUAGE_CAPABILITIES.typescript.extensions);

export function specifierExtensions(fromPath: string): readonly string[] {
  const language = languageOfExtension(extname(fromPath));
  if (!language) return [];
  if (language === "typescript" || language === "vue") return SCRIPT_FAMILY.flatMap((entry) => LANGUAGE_CAPABILITIES[entry].extensions);
  return LANGUAGE_CAPABILITIES[language].extensions;
}

/** C/C++ 一族的扩展名，cpp 语法同时覆盖纯 C。 */
export const cppExtensionPattern = /\.(c|h|cc|cpp|cxx|hpp|hh)$/;

/** TS/JS 说明符带引号；Python 与 Java 的 import 无引号，各有提取函数。 */
export const tsSpecifierPattern = /(?:from\s+|import\s*\(?\s*|require\s*\()\s*["']([^"']+)["']/g;

