/**
  源码语法高亮：零依赖的逐行 tokenizer（词法扫描，非 AST 解析）。

  为什么不用 highlight.js / Shiki：
  - 源码面板是「每行一个 <code> 元素」的渲染结构（要支持单行定位高亮），
    整块高亮后再按行切分会切断跨行标签（块注释、模板字符串）；
  - 本地优先，不引入依赖与体积（Shiki 需要 WASM/oniguruma 运行时）。

  能力边界（如实声明）：
  - 逐行扫描 + 少量跨行状态（块注释、多行字符串 / 模板串、markdown 围栏）；
    不做正则字面量、字符串插值内部、嵌套语言的细分（HTML 内 <script> 按标记语言规则处理）；
  - 识别不了的扩展名回落纯文本（整行不着色），不猜语言、不误标。
  */

/** token 类别：对应原型与 global.css 中的样式类（.kw / .fn / .str / .cm / .num / .type / .prop / .op / .tag）。 */
export type TokenKind =
  | "plain"
  | "kw" // 关键字
  | "str" // 字符串 / 模板串
  | "cm" // 注释
  | "num" // 数字 / 字面量
  | "fn" // 函数与方法调用
  | "type" // 类型名 / 类名 / 选择器
  | "prop" // 属性访问 / 对象键 / 属性名
  | "op" // 运算符
  | "tag"; // 标记语言标签名

export interface Token {
  text: string;
  kind: TokenKind;
}

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

/** 跨行扫描状态（按行顺序传递）。 */
interface ScanState {
  blockComment: boolean;
  quote: string | null;
  fence: boolean;
}

// ==== 关键字与词法常量 ====

const TSJS_KEYWORDS = new Set([
  "abstract", "any", "as", "asserts", "async", "await", "bigint", "boolean", "break", "case", "catch", "class",
  "const", "continue", "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof",
  "interface", "is", "keyof", "let", "namespace", "never", "new", "null", "number", "object", "of", "private",
  "protected", "public", "readonly", "return", "satisfies", "set", "static", "string", "super", "switch", "symbol",
  "this", "throw", "true", "try", "type", "typeof", "undefined", "unique", "unknown", "var", "void", "while", "yield"
]);

/** 其他 C 系语言的关键字并集（java / go / rust / c / cpp / c# / php / swift / kotlin / scala）。 */
const CLIKE_KEYWORDS = new Set([
  "abstract", "as", "async", "auto", "await", "bool", "boolean", "break", "byte", "case", "catch", "char", "class",
  "const", "continue", "crate", "debugger", "default", "defer", "del", "do", "double", "else", "elif", "enum",
  "except", "export", "extends", "extern", "false", "final", "finally", "float", "fn", "for", "foreach", "from",
  "func", "function", "goto", "if", "impl", "implements", "import", "in", "instanceof", "int", "interface", "internal",
  "is", "lambda", "let", "long", "loop", "match", "mod", "mut", "namespace", "native", "new", "nil", "not", "null",
  "or", "override", "package", "pass", "private", "protected", "public", "raise", "readonly", "ref", "register",
  "return", "self", "short", "signed", "sizeof", "static", "struct", "super", "switch", "synchronized", "this",
  "throw", "throws", "trait", "true", "try", "type", "typedef", "typeof", "union", "unsafe", "unsigned", "use",
  "var", "virtual", "void", "volatile", "where", "while", "with", "yield"
]);

const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield", "match", "case"
]);

const RUBY_KEYWORDS = new Set([
  "alias", "and", "begin", "break", "case", "class", "def", "do", "else", "elsif", "end", "ensure", "for", "if",
  "in", "module", "next", "nil", "not", "or", "redo", "rescue", "retry", "return", "self", "super", "then", "undef",
  "unless", "until", "when", "while", "yield", "require", "require_relative", "attr_accessor", "attr_reader",
  "attr_writer", "private", "public", "protected"
]);

const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function",
  "return", "export", "local", "readonly", "declare", "source", "set", "unset", "shift", "trap", "eval", "exit",
  "break", "continue", "true", "false", "null"
]);

const JSON_LITERALS = new Set(["true", "false", "null"]);

/** 类型位置的引导词：其后的大写标识符按类型着色。 */
const TYPE_CONTEXT = new Set([
  "new", "class", "extends", "implements", "interface", "type", "enum", "namespace", "is", "as", "keyof", "satisfies"
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const NUMBER = /^(?:0[xXbBoO][0-9a-fA-F_]+n?|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?n?)/;
const OPERATOR = /^[+\-*/%=<>!&|^~?:]+/;

/** 全大写（含数字/下划线）且长度 > 1 的标识符按命名约定视为常量，保持默认色。 */
function isConstantLike(word: string): boolean {
  return word.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(word);
}

/** 收集器：合并连续的普通文本，减少 span 数量。 */
function createCollector(): {
  tokens: Token[];
  plain: (text: string) => void;
  push: (text: string, kind: TokenKind) => void;
  flush: () => void;
} {
  const tokens: Token[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer) tokens.push({ text: buffer, kind: "plain" });
    buffer = "";
  };
  return {
    tokens,
    plain: (text) => { buffer += text; },
    push: (text, kind) => { flush(); tokens.push({ text, kind }); },
    flush
  };
}

/** 从 index 起找字符串闭合位置；返回 [结束下标, 是否闭合]。 */
function findStringEnd(line: string, index: number, quote: string): [number, boolean] {
  let cursor = index + 1;
  while (cursor < line.length) {
    if (line[cursor] === "\\") { cursor += 2; continue; }
    if (line[cursor] === quote) return [cursor + 1, true];
    cursor += 1;
  }
  return [line.length, false];
}

/** 标识符统一分类（C 系与井号注释族共用）。返回 undefined 表示按普通文本累积。 */
function classifyWord(text: string, previousChar: string, after: string, previousWord: string, keywords: Set<string>, literals?: Set<string>): TokenKind | undefined {
  if (keywords.has(text) || literals?.has(text)) return "kw";
  if (TYPE_CONTEXT.has(previousWord) && /^[A-Z]/.test(text)) return "type";
  if (/^\s*\(/.test(after)) return "fn";
  if (previousChar === ".") return "prop";
  if (/^[A-Z]/.test(text) && !isConstantLike(text)) return "type";
  return undefined;
}

// ==== C 系扫描器（tsjs / clike / json）====

interface CStyleConfig {
  keywords: Set<string>;
  literals?: Set<string>;
  lineComment?: string;
  blockComment?: [string, string];
  quotes: string[];
  /** json：字符串后紧跟冒号视为对象键。 */
  stringKeyAsProperty?: boolean;
}

const TSJS_CONFIG: CStyleConfig = { keywords: TSJS_KEYWORDS, lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"', "'", "`"] };
const CLIKE_CONFIG: CStyleConfig = { keywords: CLIKE_KEYWORDS, lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"', "'"] };
const JSON_CONFIG: CStyleConfig = { keywords: JSON_LITERALS, quotes: ['"'], stringKeyAsProperty: true };

function scanCStyle(line: string, config: CStyleConfig, state: ScanState): Token[] {
  const out = createCollector();
  let index = 0;

  // 续接上一行未闭合的块注释
  if (state.blockComment && config.blockComment) {
    const close = config.blockComment[1];
    const end = line.indexOf(close);
    if (end < 0) {
      if (line) out.push(line, "cm");
      return out.tokens;
    }
    out.push(line.slice(0, end + close.length), "cm");
    state.blockComment = false;
    index = end + close.length;
  } else if (state.quote) {
    // 续接上一行未闭合的字符串 / 模板串
    const quote = state.quote;
    const [end, closed] = findStringEnd(line, -1, quote);
    out.push(line.slice(0, end), "str");
    if (!closed) return out.tokens;
    state.quote = null;
    index = end;
  }

  let previousWord = "";
  while (index < line.length) {
    const rest = line.slice(index);
    const char = rest[0];

    if (config.blockComment && rest.startsWith(config.blockComment[0])) {
      const close = config.blockComment[1];
      const end = line.indexOf(close, index + config.blockComment[0].length);
      if (end < 0) {
        out.push(rest, "cm");
        state.blockComment = true;
        return out.tokens;
      }
      out.push(line.slice(index, end + close.length), "cm");
      index = end + close.length;
      continue;
    }

    if (config.lineComment && rest.startsWith(config.lineComment)) {
      out.push(rest, "cm");
      return out.tokens;
    }

    if (config.quotes.includes(char)) {
      const [end, closed] = findStringEnd(line, index, char);
      const text = line.slice(index, end);
      const isKey = config.stringKeyAsProperty === true && /^\s*:/.test(line.slice(end));
      out.push(text, isKey ? "prop" : "str");
      if (!closed) {
        state.quote = char;
        return out.tokens;
      }
      index = end;
      continue;
    }

    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(line[index + 1] ?? ""))) {
      const match = NUMBER.exec(rest);
      if (match) {
        out.push(match[0], "num");
        index += match[0].length;
        continue;
      }
    }

    const word = IDENTIFIER.exec(rest);
    if (word) {
      const kind = classifyWord(word[0], line.slice(0, index).trimEnd().slice(-1), line.slice(index + word[0].length), previousWord, config.keywords, config.literals);
      if (kind) out.push(word[0], kind);
      else out.plain(word[0]);
      previousWord = word[0];
      index += word[0].length;
      continue;
    }

    if (/[+\-*/%=<>!&|^~?:]/.test(char)) {
      const match = OPERATOR.exec(rest);
      if (match) {
        out.push(match[0], "op");
        index += match[0].length;
        continue;
      }
    }

    out.plain(char);
    index += 1;
  }
  out.flush();
  return out.tokens;
}

// ==== 井号注释族（python / ruby / shell / yaml 的值部分）====

interface HashStyleConfig {
  keywords: Set<string>;
  literals?: Set<string>;
  /** 三引号字符串（python）。 */
  tripleQuotes?: boolean;
  /** `$VAR` / `${VAR}` 按属性着色（shell）。 */
  variables?: boolean;
}

function scanHashStyle(line: string, config: HashStyleConfig, state: ScanState): Token[] {
  const out = createCollector();
  let index = 0;

  // 双引号内 shell 仍会展开变量，故把 `$VAR` 单独着色；单引号内是字面量，整段字符串色
  const pushString = (text: string, quote: string): void => {
    if (!text) return;
    if (!config.variables || quote !== '"') {
      out.push(text, "str");
      return;
    }
    const pattern = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-]/g;
    let cursor = 0;
    let match = pattern.exec(text);
    while (match) {
      if (match.index > cursor) out.push(text.slice(cursor, match.index), "str");
      out.push(match[0], "prop");
      cursor = match.index + match[0].length;
      match = pattern.exec(text);
    }
    if (cursor < text.length) out.push(text.slice(cursor), "str");
  };

  // 续接上一行未闭合的多行字符串（三引号或普通引号）
  if (state.quote) {
    const quote = state.quote;
    const end = line.indexOf(quote);
    if (end < 0) {
      pushString(line, quote);
      return out.tokens;
    }
    pushString(line.slice(0, end + quote.length), quote);
    state.quote = null;
    index = end + quote.length;
  }

  let previousWord = "";
  while (index < line.length) {
    const rest = line.slice(index);
    const char = rest[0];

    if (config.tripleQuotes && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const quote = rest.slice(0, 3);
      const end = line.indexOf(quote, index + 3);
      if (end < 0) {
        out.push(rest, "str");
        state.quote = quote;
        return out.tokens;
      }
      out.push(line.slice(index, end + 3), "str");
      index = end + 3;
      continue;
    }

    if (char === "#") {
      out.push(rest, "cm");
      return out.tokens;
    }

    if (char === '"' || char === "'") {
      const [end, closed] = findStringEnd(line, index, char);
      pushString(line.slice(index, end), char);
      if (!closed) {
        state.quote = char;
        return out.tokens;
      }
      index = end;
      continue;
    }

    if (config.variables && char === "$") {
      const match = /^(?:\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?$!-])/.exec(rest);
      if (match) {
        out.push(match[0], "prop");
        index += match[0].length;
        continue;
      }
    }

    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(line[index + 1] ?? ""))) {
      const match = NUMBER.exec(rest);
      if (match) {
        out.push(match[0], "num");
        index += match[0].length;
        continue;
      }
    }

    const word = IDENTIFIER.exec(rest);
    if (word) {
      const kind = classifyWord(word[0], line.slice(0, index).trimEnd().slice(-1), line.slice(index + word[0].length), previousWord, config.keywords, config.literals);
      if (kind) out.push(word[0], kind);
      else out.plain(word[0]);
      previousWord = word[0];
      index += word[0].length;
      continue;
    }

    if (/[+\-*/%=<>!&|^~?:]/.test(char)) {
      const match = OPERATOR.exec(rest);
      if (match) {
        out.push(match[0], "op");
        index += match[0].length;
        continue;
      }
    }

    out.plain(char);
    index += 1;
  }
  out.flush();
  return out.tokens;
}

// ==== CSS ====

function scanCss(line: string, state: ScanState): Token[] {
  const out = createCollector();
  let index = 0;

  if (state.blockComment) {
    const end = line.indexOf("*/");
    if (end < 0) {
      if (line) out.push(line, "cm");
      return out.tokens;
    }
    out.push(line.slice(0, end + 2), "cm");
    state.blockComment = false;
    index = end + 2;
  }

  // 值位置（冒号之后）才把 #rgb 当颜色；之前的 #id 是选择器
  let sawColon = false;
  while (index < line.length) {
    const rest = line.slice(index);
    const char = rest[0];

    if (rest.startsWith("/*")) {
      const end = line.indexOf("*/", index + 2);
      if (end < 0) {
        out.push(rest, "cm");
        state.blockComment = true;
        return out.tokens;
      }
      out.push(line.slice(index, end + 2), "cm");
      index = end + 2;
      continue;
    }

    if (char === '"' || char === "'") {
      const [end] = findStringEnd(line, index, char);
      out.push(line.slice(index, end), "str");
      index = end;
      continue;
    }

    const atRule = /^@[A-Za-z-]+/.exec(rest);
    if (atRule) {
      out.push(atRule[0], "kw");
      index += atRule[0].length;
      continue;
    }

    if (char === "#" && sawColon) {
      const color = /^#[0-9a-fA-F]{3,8}\b/.exec(rest);
      if (color) {
        out.push(color[0], "num");
        index += color[0].length;
        continue;
      }
    }

    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(line[index + 1] ?? ""))) {
      const match = /^[0-9][0-9_]*(?:\.[0-9]+)?(?:%|px|em|rem|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt|cm|mm|in|q)?/.exec(rest);
      if (match) {
        out.push(match[0], "num");
        index += match[0].length;
        continue;
      }
    }

    // CSS 的标识符可含连字符（pane-header / -webkit-box），不能用通用 IDENTIFIER 先切
    const word = /^-?[A-Za-z_][A-Za-z0-9_-]*/.exec(rest);
    if (word) {
      const text = word[0];
      const after = line.slice(index + text.length);
      const previous = line.slice(0, index).trimEnd().slice(-1);
      if (/^\s*:/.test(after)) {
        out.push(text, "prop");
        sawColon = true;
      } else if (previous === "." || previous === "#") {
        out.push(text, "type");
      } else if (/^\s*\(/.test(after)) {
        out.push(text, "fn");
      } else if (sawColon) {
        out.plain(text);
      } else {
        // 选择器位置（元素 / 嵌套选择器）
        out.push(text, "type");
      }
      index += text.length;
      continue;
    }

    if (char === ":") sawColon = true;
    out.plain(char);
    index += 1;
  }
  out.flush();
  return out.tokens;
}

// ==== 标记语言（html / xml / vue / svelte）====

function scanMarkup(line: string, state: ScanState): Token[] {
  const out = createCollector();
  let index = 0;

  if (state.blockComment) {
    const end = line.indexOf("-->");
    if (end < 0) {
      if (line) out.push(line, "cm");
      return out.tokens;
    }
    out.push(line.slice(0, end + 3), "cm");
    state.blockComment = false;
    index = end + 3;
  }

  let insideTag = false;
  while (index < line.length) {
    const rest = line.slice(index);

    if (rest.startsWith("<!--")) {
      const end = line.indexOf("-->", index + 4);
      if (end < 0) {
        out.push(rest, "cm");
        state.blockComment = true;
        return out.tokens;
      }
      out.push(line.slice(index, end + 3), "cm");
      index = end + 3;
      continue;
    }

    const char = rest[0];

    if (char === "<") {
      const tag = /^(?:<\/?[A-Za-z][A-Za-z0-9.:-]*|<\/?>|<!\[CDATA\[)/.exec(rest);
      if (tag) {
        out.push(tag[0], "tag");
        index += tag[0].length;
        insideTag = true;
        continue;
      }
    }

    if (char === ">" && insideTag) {
      out.push(">", "tag");
      insideTag = false;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const [end] = findStringEnd(line, index, char);
      out.push(line.slice(index, end), "str");
      index = end;
      continue;
    }

    if (insideTag) {
      const attribute = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(rest);
      if (attribute) {
        out.push(attribute[0], "prop");
        index += attribute[0].length;
        continue;
      }
      if (char === "=") {
        out.push("=", "op");
        index += 1;
        continue;
      }
    }

    out.plain(char);
    index += 1;
  }
  out.flush();
  return out.tokens;
}

// ==== Markdown ====

function scanMarkdown(line: string, state: ScanState): Token[] {
  if (state.fence) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      state.fence = false;
      return [{ text: line, kind: "op" }];
    }
    // 围栏内的语言未知：保持纯文本，不猜语言误标
    return [{ text: line, kind: "plain" }];
  }

  if (/^\s*(?:```|~~~)/.test(line)) {
    state.fence = true;
    return [{ text: line, kind: "op" }];
  }

  const heading = /^(#{1,6})(\s.*)?$/.exec(line);
  if (heading) {
    return [
      { text: heading[1], kind: "kw" },
      { text: heading[2] ?? "", kind: "plain" }
    ];
  }

  const tokens: Token[] = [];
  const pattern = /(`[^`]*`)|(\*\*[^*]+\*\*)|(\[[^\]]*\]\([^)]*\))|(^\s*(?:[-*+]|\d+\.)\s)|(^\s*>\s?)/g;
  let cursor = 0;
  let match = pattern.exec(line);
  while (match) {
    if (match.index > cursor) tokens.push({ text: line.slice(cursor, match.index), kind: "plain" });
    const text = match[0];
    const kind: TokenKind = match[1] ? "str" : match[3] ? "type" : "op";
    tokens.push({ text, kind });
    cursor = match.index + text.length;
    match = pattern.exec(line);
  }
  if (cursor < line.length) tokens.push({ text: line.slice(cursor), kind: "plain" });
  return tokens.length ? tokens : [{ text: line, kind: "plain" }];
}

// ==== YAML ====

function scanYaml(line: string, state: ScanState): Token[] {
  const tokens: Token[] = [];
  const commentAt = findYamlComment(line);
  const body = commentAt < 0 ? line : line.slice(0, commentAt);
  const comment = commentAt < 0 ? "" : line.slice(commentAt);

  const indent = /^\s*/.exec(body)![0];
  const listItem = /^-\s+/.exec(body.slice(indent.length));
  if (indent) tokens.push({ text: indent, kind: "plain" });
  if (listItem) tokens.push({ text: listItem[0], kind: "op" });

  const valueAt = indent.length + (listItem?.[0].length ?? 0);
  const key = /^([A-Za-z_][A-Za-z0-9_.-]*)(\s*:)/.exec(body.slice(valueAt));
  const valueConfig: HashStyleConfig = { keywords: JSON_LITERALS };
  if (key) {
    tokens.push({ text: key[1], kind: "prop" });
    tokens.push({ text: key[2], kind: "op" });
    tokens.push(...scanHashStyle(body.slice(valueAt + key[0].length), valueConfig, state));
  } else {
    tokens.push(...scanHashStyle(body.slice(valueAt), valueConfig, state));
  }
  if (comment) tokens.push({ text: comment, kind: "cm" });
  return tokens;
}

/** 找 YAML 中引号之外的注释起点。 */
function findYamlComment(line: string): number {
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single) double = !double;
    else if (char === "#" && !single && !double && (index === 0 || /\s/.test(line[index - 1]))) return index;
  }
  return -1;
}

// ==== 入口 ====

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
