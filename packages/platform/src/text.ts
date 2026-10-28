/** 词法命中判定与切词；词边界语义只维护这一份。 */

/** 主题词元：texts 各自整体 + 分词（≥2 字符），全小写。 */
export function themeTokens(...texts: string[]): string[] {
  const tokens = new Set<string>();
  for (const text of texts) {
    const lowered = text.toLowerCase().trim();
    if (!lowered) continue;
    tokens.add(lowered);
    for (const part of lowered.split(/[\s,，、/·:：_-]+/)) if (part.length >= 2) tokens.add(part);
  }
  return [...tokens];
}

/** 连续中文段切成二分词（滑动窗口），ASCII 段原样保留；供查询侧切词。 */
export function segmentForLookup(text: string): string {
  const out: string[] = [];
  for (const chunk of text.split(/([一-龥]+)/)) {
    if (!/^[一-龥]+$/.test(chunk)) {
      if (chunk.trim()) out.push(chunk.trim());
      continue;
    }
    if (chunk.length <= 2) {
      out.push(chunk);
      continue;
    }
    for (let at = 0; at + 2 <= chunk.length; at += 1) out.push(chunk.slice(at, at + 2));
  }
  return out.join(" ");
}
/** 把任意文本切成「词」：非字母数字断开 + camelCase 边界（IOService → io/service 归一为整词）。 */
export function wordsOf(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** 中文与 ≥6 字符 ASCII 词元子串匹配；≤5 字符 ASCII 词元只允许整词前缀。 */
export function tokenHits(token: string, text: string): boolean {
  if (/[^\x00-\x7F]/.test(token)) return text.includes(token);
  if (token.length >= 6) return text.includes(token);
  return wordsOf(text).some((word) => word.startsWith(token));
}
