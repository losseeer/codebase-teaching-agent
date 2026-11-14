import { describe, expect, it } from "vitest";

import { activateProfileUseCase, deleteProfileUseCase } from "./profiles.js";

describe("配置切换", () => {
  it("不存在的配置报 not-found", async () => {
    const result = await activateProfileUseCase("p_missing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe("not-found");
  });

  it("配置不完整时预检失败且不切换", async () => {
    const result = await activateProfileUseCase("p_none");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("不存在");
    expect(deleteProfileUseCase("p_none").ok).toBe(false);
  });
});
