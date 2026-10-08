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

/**
  把连续中文段切成二分词（滑动窗口），ASCII 段原样保留：`缓存击穿` → `缓存 存击 击穿`。

  为什么要它：`themeTokens` 只按空白与标点断句，一句自然的中文提问（「缓存到期的那一瞬间怎么防止打爆数据库」）
  整串是一个词元，`tokenHits` 拿它去 `includes` 语料 ⇒ 注定零命中。也就是说**词法臂在中文整句上的失败，
  一部分不是「没有语义」，而是查询侧根本没切词**。买 embedding 之前必须先量掉这一格，否则会把切词的收益记到向量头上。
  现在的落点（2026-10-04 拍板，开发日志 §27）：`source/search-code.ts` 的**最后一级兜底**——
  只有原样查询零命中才切词，且要过 DF 闸与「同一文件 ≥2 枚互不重叠词元」闸；评测台架（`scripts/eval-run.ts`）
  拿它当「第三臂」量值不值得。整句查询与关键词查询的第一遍行为一字未动。
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
