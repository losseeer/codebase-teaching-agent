import { type ScanState, type Token, type TokenKind } from "./codeToken";

export function scanMarkdown(line: string, state: ScanState): Token[] {
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
