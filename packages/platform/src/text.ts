/**
  词法命中判定（全项目唯一实现）：检索工具（source/search-code）使用，
  词边界语义只维护这一份。
*/

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

/**
  把连续中文段切成二分词（滑动窗口），ASCII 段原样保留：`缓存击穿` → `缓存 存击 击穿`。
  `themeTokens` 只按空白与标点断句，一句中文提问整串是一个词元，拿去子串匹配语料注定零命中——
  这补的是查询侧的切词。
  落点仅在 `source/search-code.ts` 的最后一级兜底：原样查询零命中才切词，
  且要过 DF 闸与「同一文件 ≥2 枚互不重叠词元」闸；整句与关键词查询的第一遍行为不变。
  */
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

/**
  词元命中判定：
  - 中文词元（含非 ASCII）：子串匹配——中文没有词边界问题，「缓存」命中「封装缓存读写」是有效信号；
  - ≥6 字符 ASCII 词元：子串匹配——长词几乎不会偶然出现在别的词里；
  - ≤5 字符 ASCII 词元（"cache"/"lock"/"http"）：只允许整词前缀——"http" 命中
    `HttpServletRequest`（切词后 http 是整词）、路径段 `io/`、`IOService`，不命中 `Configuration`。
*/
export function tokenHits(token: string, text: string): boolean {
  if (/[^\x00-\x7F]/.test(token)) return text.includes(token);
  if (token.length >= 6) return text.includes(token);
  return wordsOf(text).some((word) => word.startsWith(token));
}
