import { type Token, type TokenKind } from "./codeToken";
import { TYPE_CONTEXT } from "./keywordTables";

export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*/;
export const NUMBER = /^(?:0[xXbBoO][0-9a-fA-F_]+n?|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?n?)/;
export const OPERATOR = /^[+\-*/%=<>!&|^~?:]+/;

/** 全大写（含数字/下划线）且长度 > 1 的标识符按命名约定视为常量，保持默认色。 */
function isConstantLike(word: string): boolean {
  return word.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(word);
}

/** 收集器：合并连续的普通文本，减少 span 数量。 */
export function createCollector(): {
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
export function findStringEnd(line: string, index: number, quote: string): [number, boolean] {
  let cursor = index + 1;
  while (cursor < line.length) {
    if (line[cursor] === "\\") { cursor += 2; continue; }
    if (line[cursor] === quote) return [cursor + 1, true];
    cursor += 1;
  }
  return [line.length, false];
}

/** 标识符统一分类（C 系与井号注释族共用）。返回 undefined 表示按普通文本累积。 */
export function classifyWord(text: string, previousChar: string, after: string, previousWord: string, keywords: Set<string>, literals?: Set<string>): TokenKind | undefined {
  if (keywords.has(text) || literals?.has(text)) return "kw";
  if (TYPE_CONTEXT.has(previousWord) && /^[A-Z]/.test(text)) return "type";
  if (/^\s*\(/.test(after)) return "fn";
  if (previousChar === ".") return "prop";
  if (/^[A-Z]/.test(text) && !isConstantLike(text)) return "type";
  return undefined;
}
