import { type ScanState, type Token } from "./codeToken";
import { CLIKE_KEYWORDS, JSON_LITERALS, TSJS_KEYWORDS } from "./keywordTables";
import { classifyWord, createCollector, findStringEnd, IDENTIFIER, NUMBER, OPERATOR } from "./scanPrimitives";

// ==== C 系扫描器（tsjs / clike / json）====

export interface CStyleConfig {
  keywords: Set<string>;
  literals?: Set<string>;
  lineComment?: string;
  blockComment?: [string, string];
  quotes: string[];
  /** json：字符串后紧跟冒号视为对象键。 */
  stringKeyAsProperty?: boolean;
}

export const TSJS_CONFIG: CStyleConfig = { keywords: TSJS_KEYWORDS, lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"', "'", "`"] };
export const CLIKE_CONFIG: CStyleConfig = { keywords: CLIKE_KEYWORDS, lineComment: "//", blockComment: ["/*", "*/"], quotes: ['"', "'"] };
export const JSON_CONFIG: CStyleConfig = { keywords: JSON_LITERALS, quotes: ['"'], stringKeyAsProperty: true };

export function scanCStyle(line: string, config: CStyleConfig, state: ScanState): Token[] {
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
