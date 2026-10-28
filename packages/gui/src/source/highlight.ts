import { type ScanState, type Token } from "./codeToken";
import { CLIKE_CONFIG, JSON_CONFIG, scanCStyle, TSJS_CONFIG } from "./cFamilyScanner";
import { scanCss } from "./cssScanner";
import { scanHashStyle, scanYaml } from "./hashFamilyScanner";
import { PYTHON_KEYWORDS, RUBY_KEYWORDS, SHELL_KEYWORDS } from "./keywordTables";
import { scanMarkdown } from "./markdownScanner";
import { scanMarkup } from "./markupScanner";

/**
  源码语法高亮：零依赖的逐行 tokenizer，非 AST 解析。
  跨行只保持少量状态；不做正则字面量、字符串插值与嵌套语言的细分。
  未知扩展名回落纯文本，不猜语言。
  */

/** 语言族（同族共享扫描器）。 */
export type LanguageId =
  | "tsjs"
  | "clike"
  | "python"
  | "ruby"
  | "json"
  | "css"
  | "markup"
  | "markdown"
  | "shell"
  | "yaml"
  | "text";

const EXTENSION_LANGUAGE: Record<string, LanguageId> = {
  ts: "tsjs", tsx: "tsjs", js: "tsjs", jsx: "tsjs", mjs: "tsjs", cjs: "tsjs", mts: "tsjs", cts: "tsjs",
  py: "python", pyi: "python",
  rb: "ruby", rake: "ruby", gemspec: "ruby",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "css", less: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  yml: "yaml", yaml: "yaml",
  java: "clike", kt: "clike", kts: "clike", go: "clike", rs: "clike", c: "clike", h: "clike",
  cc: "clike", cpp: "clike", hpp: "clike", cs: "clike", php: "clike", swift: "clike", scala: "clike", m: "clike"
};

/** 按文件扩展名判定语言族；未知扩展名 → "text"（整行纯文本，不着色）。 */
export function detectLanguage(path: string): LanguageId {
  const name = path.split(/[\\/]/).pop() ?? "";
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return EXTENSION_LANGUAGE[extension] ?? "text";
}

/** 逐行 tokenize；跨行状态（块注释、多行字符串、markdown 围栏）在行间传递。 */
export function highlightLines(lines: string[], language: LanguageId): Token[][] {
  const state: ScanState = { blockComment: false, quote: null, fence: false };
  return lines.map((line) => {
    if (!line) return [{ text: "", kind: "plain" }];
    const tokens = ((): Token[] => {
      switch (language) {
        case "tsjs":
          return scanCStyle(line, TSJS_CONFIG, state);
        case "clike":
          return scanCStyle(line, CLIKE_CONFIG, state);
        case "json":
          return scanCStyle(line, JSON_CONFIG, state);
        case "python":
          return scanHashStyle(line, { keywords: PYTHON_KEYWORDS, tripleQuotes: true }, state);
        case "ruby":
          return scanHashStyle(line, { keywords: RUBY_KEYWORDS, literals: new Set(["nil", "true", "false"]) }, state);
        case "shell":
          return scanHashStyle(line, { keywords: SHELL_KEYWORDS, variables: true }, state);
        case "yaml":
          return scanYaml(line, state);
        case "css":
          return scanCss(line, state);
        case "markup":
          return scanMarkup(line, state);
        case "markdown":
          return scanMarkdown(line, state);
        default:
          return [{ text: line, kind: "plain" }];
      }
    })();
    return tokens.length ? tokens : [{ text: line, kind: "plain" }];
  });
}
