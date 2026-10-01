import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLlmRuntimeProvider, effectiveLlmConfig, getLlmRuntimeSettings, maskSecret, publicLlmSettings, restoreLlmRuntimeSettings, setLlmRuntimeSettings } from "./runtime.js";

/**
  运行时 LLM 设置的三件事：部分更新语义（留空 = 清除并回落 .env）、落盘/重启恢复、密钥只在对外视图里以掩码出现。
  设置文件按 TUTOR_LLM_SETTINGS_FILE 指向临时目录——默认落点是 ~/.codebase-tutor/，那是**用户的产品数据**，测试不许碰。
  */
const ENV_KEYS = ["TUTOR_LLM_SETTINGS_FILE", "TUTOR_LLM_PROVIDER", "TUTOR_LLM_MODEL", "TUTOR_TEACHING_PROVIDER", "TUTOR_TEACHING_MODEL", "TUTOR_OPENAI_URL", "TUTOR_OPENAI_API_KEY", "OPENAI_API_KEY", "TUTOR_OLLAMA_URL"];

let directory = "";
let settingsFile = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "codebase-tutor-llm-settings-"));
  settingsFile = join(directory, "llm-settings.json");
  process.env.TUTOR_LLM_SETTINGS_FILE = settingsFile;
  setLlmRuntimeSettings({ provider: "", model: "", baseUrl: "", apiKey: "", thinking: "auto" });
});

afterEach(() => {
  // 先把内存态清干净再删 TUTOR_LLM_SETTINGS_FILE：反过来的话这次清理会写到默认落点 ~/.codebase-tutor/，
  // 等于测试在用户机上凭空造了一份 LLM 设置文件（写出来的第一轮就踩过这个）
  setLlmRuntimeSettings({ provider: "", model: "", baseUrl: "", apiKey: "", thinking: "auto" });
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("setLlmRuntimeSettings（部分更新）", () => {
  it("未提供的字段保持不变；空串是把该项清除并回落 .env", () => {
    setLlmRuntimeSettings({ provider: "openai-compatible", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-gui-key" });
    setLlmRuntimeSettings({ model: "glm-4.7" });
    expect(getLlmRuntimeSettings()).toMatchObject({ provider: "openai-compatible", model: "glm-4.7", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-gui-key" });

    setLlmRuntimeSettings({ apiKey: "", model: "  " });
    expect(getLlmRuntimeSettings().apiKey).toBe("");
    expect(getLlmRuntimeSettings().model).toBe("");
  });

  it("文本字段两侧空白被裁掉（粘贴进来的 slug 与 key 常带换行）", () => {
    setLlmRuntimeSettings({ model: "\n  glm-4.7  \n", baseUrl: " https://a.example.com/v1 " });
    expect(getLlmRuntimeSettings()).toMatchObject({ model: "glm-4.7", baseUrl: "https://a.example.com/v1" });
  });
});

describe("落盘与启动恢复", () => {
  it("保存即落盘，重启（restore）读回同一份设置，含明文密钥", () => {
    setLlmRuntimeSettings({ provider: "openai-compatible", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-gui-key", thinking: "high" });
    const persisted = readFileSync(settingsFile, "utf8");
    expect(persisted).toContain("sk-gui-key");

    // 模拟重启：清空内存态，再把上一轮落盘的内容放回原处，由 restore 从磁盘重建
    setLlmRuntimeSettings({ provider: "", model: "", baseUrl: "", apiKey: "", thinking: "auto" });
    writeFileSync(settingsFile, persisted, "utf8");
    expect(restoreLlmRuntimeSettings()).toMatchObject({ provider: "openai-compatible", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-gui-key", thinking: "high" });
  });

  it("设置文件是 0600（明文密钥落在用户目录，不能对同机其它用户可读）", () => {
    setLlmRuntimeSettings({ apiKey: "sk-gui-key" });
    expect(statSync(settingsFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).apiKey).toBe("sk-gui-key");
  });

  it("文件缺失或损坏都按「维持当前内存态」处理，不阻断启动", () => {
    setLlmRuntimeSettings({ model: "in-memory" });
    rmSync(settingsFile);
    expect(restoreLlmRuntimeSettings().model).toBe("in-memory");

    writeFileSync(settingsFile, "{ broken", "utf8");
    expect(restoreLlmRuntimeSettings().model).toBe("in-memory");

    writeFileSync(settingsFile, JSON.stringify({ provider: 42, thinking: "nonsense", apiKey: ["sk"] }), "utf8");
    expect(restoreLlmRuntimeSettings()).toMatchObject({ provider: "", thinking: "auto", apiKey: "" });
  });
});

describe("对外视图与生效配置", () => {
  it("publicLlmSettings 里没有明文密钥，只有掩码与存在标记", () => {
    setLlmRuntimeSettings({ provider: "openai-compatible", model: "deepseek-chat", apiKey: "sk-abcdef0123456789" });
    const view = publicLlmSettings();
    expect(JSON.stringify(view)).not.toContain("sk-abcdef0123456789");
    expect(view.hasApiKey).toBe(true);
    expect(view.apiKeyMasked).not.toContain("abcdef");
    expect(view.provider).toBe("openai-compatible");
    expect("apiKey" in view).toBe(false);
  });

  it("maskSecret：长密钥露头尾、短密钥全遮、空串返回空", () => {
    expect(maskSecret("sk-abcdef0123456789")).toBe("sk-********6789");
    expect(maskSecret("short")).toBe("*****");
    expect(maskSecret("")).toBe("");
  });

  it("effectiveLlmConfig 走「GUI 覆盖 → .env → 协议默认」三层回落", () => {
    process.env.TUTOR_LLM_PROVIDER = "openai-compatible";
    process.env.TUTOR_LLM_MODEL = "env-model";
    process.env.TUTOR_OPENAI_URL = "https://env.example.com/v1";
    process.env.OPENAI_API_KEY = "env-key";

    expect(effectiveLlmConfig()).toMatchObject({ provider: "openai-compatible", model: "env-model", baseUrl: "https://env.example.com/v1", hasApiKey: true });

    setLlmRuntimeSettings({ model: "gui-model", apiKey: "gui-key" });
    expect(effectiveLlmConfig()).toMatchObject({ model: "gui-model", baseUrl: "https://env.example.com/v1", hasApiKey: true });

    // 服务商换成 ollama：端点回到该协议默认，且这个协议不认密钥
    setLlmRuntimeSettings({ provider: "ollama" });
    expect(effectiveLlmConfig()).toMatchObject({ provider: "ollama", model: "gui-model", baseUrl: "http://127.0.0.1:11434", hasApiKey: false });
  });

  it("buildLlmRuntimeProvider 用运行时设置建实例：.env 一个字段都没配也能跑通", () => {
    setLlmRuntimeSettings({ provider: "openai-compatible", model: "gui-model", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "gui-key" });
    expect(buildLlmRuntimeProvider("teaching")?.modelVersion).toContain("gui-model");
    setLlmRuntimeSettings({ provider: "" });
    expect(buildLlmRuntimeProvider("teaching")).toBeUndefined();
  });

  it("light 角色的思考档位恒为 off，与运行时档位无关（省 reasoning token 的行为约定）", () => {
    setLlmRuntimeSettings({ provider: "openai-compatible", model: "deepseek-chat", thinking: "high" });
    expect(buildLlmRuntimeProvider("light")?.name).toContain("thinking:off");
    expect(buildLlmRuntimeProvider("teaching")?.name).toContain("thinking:high");
  });
});
