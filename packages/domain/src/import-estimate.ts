export interface ImportEstimate {
  cachedFiles: number;
  summarizedFiles: number;
  estimatedInputTokens: number;
  estimatedCostUsd: number;
  provider: string;
  modelVersion: string;
  /** 本次新算的摘要里，有多少条没拿到模型结果、由确定性档补齐（旧数据没有该字段）。 */
  fallbackFiles?: number;
}
