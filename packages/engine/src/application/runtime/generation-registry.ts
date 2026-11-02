/**
  在途出题的注册表：按 repositoryId + jobId 找到 AbortController。
  点「取消」只中止这一趟；出题结束（成功、失败或取消）都要 dispose。
*/
const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface GenerationHandle {
  /** 校验后的 jobId；没给、格式非法或已在跑时缺省。 */
  readonly jobId?: string;
  /** 无法登记时缺省：这一趟不能取消。 */
  readonly signal?: AbortSignal;
  dispose(): void;
}

interface ActiveGeneration {
  controller: AbortController;
  startedAt: number;
}

const active = new Map<string, ActiveGeneration>();
const keyOf = (repositoryId: string, jobId: string): string => `${repositoryId}\u0000${jobId}`;

/** 登记一趟出题；同一仓同一 jobId 已在跑时不覆盖既有登记。 */
export function beginGeneration(repositoryId: string, jobId: unknown): GenerationHandle {
  const id = typeof jobId === "string" && JOB_ID.test(jobId.trim()) ? jobId.trim() : undefined;
  if (!id) return { dispose: () => undefined };
  const key = keyOf(repositoryId, id);
  if (active.has(key)) return { jobId: id, dispose: () => undefined };
  const generation: ActiveGeneration = { controller: new AbortController(), startedAt: Date.now() };
  active.set(key, generation);
  return {
    jobId: id,
    signal: generation.controller.signal,
    dispose: () => { if (active.get(key) === generation) active.delete(key); }
  };
}

/** 中止这一仓的这一趟；不在跑时返回 false，重复点击不报错。 */
export function abortGeneration(repositoryId: string, jobId: unknown): { canceled: boolean; waitedMs?: number } {
  const id = typeof jobId === "string" && JOB_ID.test(jobId.trim()) ? jobId.trim() : undefined;
  const key = id ? keyOf(repositoryId, id) : "";
  const generation = id ? active.get(key) : undefined;
  if (!generation) return { canceled: false };
  active.delete(key);
  generation.controller.abort();
  return { canceled: true, waitedMs: Date.now() - generation.startedAt };
}
