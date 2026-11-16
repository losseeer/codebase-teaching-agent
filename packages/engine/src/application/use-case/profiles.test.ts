import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activateProfileUseCase } from "./profiles.js";

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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureCurrentProfileUseCase, deleteProfileUseCase, listProfilesUseCase, saveProfileUseCase } from "./profiles.js";
import { llmProfileStore, llmRuntime } from "../../infrastructure/composition-root.js";

describe("配置增删的一致性", () => {
  let dir = "";
  const saved = { profiles: process.env.TUTOR_LLM_PROFILES_FILE, settings: process.env.TUTOR_LLM_SETTINGS_FILE };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutor-profiles-"));
    process.env.TUTOR_LLM_PROFILES_FILE = join(dir, "profiles.json");
    process.env.TUTOR_LLM_SETTINGS_FILE = join(dir, "settings.json");
  });
  afterEach(() => {
    for (const [key, value] of [["TUTOR_LLM_PROFILES_FILE", saved.profiles], ["TUTOR_LLM_SETTINGS_FILE", saved.settings]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("重名被拒；删到最后一套也被拒", () => {
    expect(captureCurrentProfileUseCase("主力").ok).toBe(true);
    expect(captureCurrentProfileUseCase("主力")).toMatchObject({ ok: false, failure: "invalid" });
    expect(deleteProfileUseCase(listProfilesUseCase().profiles[0].id)).toMatchObject({ ok: false, failure: "invalid" });
  });

  it("删当前配置后 activeId 置空，运行时一并清空", () => {
    captureCurrentProfileUseCase("甲");
    const second = saveProfileUseCase({ name: "乙", provider: "openai-compatible", model: "m", baseUrl: "https://x/v1" });
    expect(second.ok).toBe(true);
    const active = listProfilesUseCase().activeId;
    llmRuntime.setLlmRuntimeSettings({ provider: "openai-compatible", model: "m", baseUrl: "https://x/v1", apiKey: "k" });

    expect(deleteProfileUseCase(active).ok).toBe(true);
    expect(listProfilesUseCase().activeId).toBe("");
    expect(llmRuntime.getLlmRuntimeSettings().model).toBe("");
    expect(llmProfileStore.readProfileFile().profiles.length).toBe(1);
  });
});

import { networkReason } from "./profiles.js";

describe("网络错误原因", () => {
  it("带出底层 cause 的 code 与说明；没有 cause 就用原消息", () => {
    const withCause = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND maas.example.com" } });
    expect(networkReason(withCause)).toBe("getaddrinfo ENOTFOUND maas.example.com（ENOTFOUND）");
    expect(networkReason(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe("ECONNREFUSED");
    expect(networkReason(new Error("fetch failed"))).toBe("fetch failed");
  });
});
