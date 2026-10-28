import { type ScanState, type Token } from "./codeToken";
import { createCollector, findStringEnd } from "./scanPrimitives";

export function scanCss(line: string, state: ScanState): Token[] {
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

    // CSS 标识符可含连字符，不能先用通用 IDENTIFIER 切
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
    // 选择器位置
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
