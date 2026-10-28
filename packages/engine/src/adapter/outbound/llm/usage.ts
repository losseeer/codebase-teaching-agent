import type { LlmUsage } from "../../../application/port/llm-provider.js";

/** 用量相加：缓存字段两边都缺才不带，单边有就累加。 */
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
