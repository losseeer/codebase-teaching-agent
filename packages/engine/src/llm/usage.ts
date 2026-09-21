import type { LlmUsage } from "./provider.js";

/**
  用量相加的**唯一实现**（主调用 + 按需深入 / 工具循环各轮 / 动作决策 / 翻译层）。

  ⚠️ **四个字段都要搬**：只搬 in/out 会把「前缀缓存命中」悄悄变成「未命中」——项目里为此吃过
  两次亏：§1.3 的聚合丢字段，以及 `harness`/`tool-loop`/`entry-suggest` 各自手写的相加函数（journal
  实测：教学回合的 `cache_hit_tokens` 恒为 null，因为两段相加时把该字段丢了）。别再新增本地副本。
  两边都没上报某缓存字段时才不带它——别用 `?? 0` 把「没上报」说成「没命中」。
*/
export function addUsage(left: LlmUsage | undefined, right: LlmUsage | undefined): LlmUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const sum = (key: "promptCacheHitTokens" | "promptCacheMissTokens"): { [k in typeof key]?: number } =>
    left[key] === undefined && right[key] === undefined ? {} : { [key]: (left[key] ?? 0) + (right[key] ?? 0) };
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...sum("promptCacheHitTokens"),
    ...sum("promptCacheMissTokens")
  };
}
