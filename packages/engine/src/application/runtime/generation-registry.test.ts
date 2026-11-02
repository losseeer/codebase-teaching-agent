import { describe, expect, it } from "vitest";

import { abortGeneration, beginGeneration } from "./generation-registry.js";

describe("出题取消登记", () => {
  it("按仓与 jobId 中止，只影响这一趟", () => {
    const first = beginGeneration("repo-a", "job_aaaaaaaa");
    const second = beginGeneration("repo-a", "job_bbbbbbbb");
    expect(first.signal?.aborted).toBe(false);
    expect(abortGeneration("repo-a", "job_aaaaaaaa")).toMatchObject({ canceled: true });
    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);
    first.dispose();
    second.dispose();
  });

  it("同一 jobId 不覆盖既有登记；dispose 之后不能再取消", () => {
    const first = beginGeneration("repo-b", "job_cccccccc");
    const duplicate = beginGeneration("repo-b", "job_cccccccc");
    expect(duplicate.signal).toBeUndefined();
    expect(abortGeneration("repo-b", "job_cccccccc").canceled).toBe(true);
    expect(first.signal?.aborted).toBe(true);
    first.dispose();
    expect(abortGeneration("repo-b", "job_cccccccc").canceled).toBe(false);
  });

  it("非法或缺失 jobId 不登记", () => {
    expect(beginGeneration("repo-c", "short").signal).toBeUndefined();
    expect(beginGeneration("repo-c", undefined).signal).toBeUndefined();
  });
});
