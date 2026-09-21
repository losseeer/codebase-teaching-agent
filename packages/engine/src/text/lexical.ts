/**
  词法命中判定（全项目唯一实现）：推荐入口排序（coursetree/entry-suggest）与
  检索工具（source/search-code）共用，P2 词边界语义只维护这一份。
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

/** 把任意文本切成「词」：非字母数字断开 + camelCase 边界（IOService → io/service 归一为整词）。 */
export function wordsOf(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
  词元命中判定（P2，2026-09-20）。真仓实测：`includes` 子串匹配下 `"io"` 命中一切
  `Configur-at-ion`/`Except-ion`，102 个假阳性淹没整个「操作系统」候选池。
  - 中文词元（含非 ASCII）：子串匹配——中文没有词边界问题，「缓存」命中「封装缓存读写」是有效信号。
  - ≥6 字符 ASCII 词元：子串匹配——长词几乎不会偶然出现在别的词里。
  - ≤5 字符 ASCII 词元（"cache"/"lock"/"http"）：只允许整词前缀——"http" 命中
    `HttpServletRequest`（切词后 http 是整词）、路径段 `io/`、`IOService`；不再命中 `Configuration`。
*/
export function tokenHits(token: string, text: string): boolean {
  if (/[^\x00-\x7F]/.test(token)) return text.includes(token);
  if (token.length >= 6) return text.includes(token);
  return wordsOf(text).some((word) => word.startsWith(token));
}
