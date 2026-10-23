import { type ScanState, type Token } from "./codeToken";
import { JSON_LITERALS } from "./keywordTables";
import { classifyWord, createCollector, findStringEnd, IDENTIFIER, NUMBER, OPERATOR } from "./scanPrimitives";

// ==== 井号注释族（python / ruby / shell / yaml 的值部分）====

export interface HashStyleConfig {
  keywords: Set<string>;
  literals?: Set<string>;
  /** 三引号字符串（python）。 */
  tripleQuotes?: boolean;
  /** `$VAR` / `${VAR}` 按属性着色（shell）。 */
  variables?: boolean;
}

export function scanHashStyle(line: string, config: HashStyleConfig, state: ScanState): Token[] {
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

export function scanYaml(line: string, state: ScanState): Token[] {
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
