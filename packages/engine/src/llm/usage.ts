import type { LlmUsage } from "./provider.js";

/**
  用量相加的唯一实现（主调用 + 按需深入 / 工具循环各轮 / 动作决策 / 翻译层）。
  四个字段都要搬：只搬 in/out 会把「前缀缓存命中」悄悄变成「未命中」。
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
