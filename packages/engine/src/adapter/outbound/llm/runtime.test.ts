import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLlmRuntimeProvider, effectiveLlmConfig, getLlmRuntimeSettings, maskSecret, normalizeRate, publicLlmSettings, restoreLlmRuntimeSettings, setLlmRuntimeSettings } from "./runtime.js";

/**
  运行时 LLM 设置的三件事：部分更新语义（留空 = 清除并回落 .env）、落盘/重启恢复、密钥只在对外视图里以掩码出现。
  外加单价那这三个字段：它同样「界面上改、立即生效」，但判据更硬——脏值会一路流进预算闸门（见 cost.test.ts）。
  设置文件按 TUTOR_LLM_SETTINGS_FILE 指向临时目录——默认落点是用户的产品数据，测试不许碰。
  */
const ENV_KEYS = ["TUTOR_LLM_SETTINGS_FILE", "TUTOR_LLM_PROVIDER", "TUTOR_LLM_MODEL", "TUTOR_OPENAI_URL", "OPENAI_API_KEY", "TUTOR_OLLAMA_URL", "TUTOR_INPUT_USD_PER_MILLION", "TUTOR_OUTPUT_USD_PER_MILLION", "TUTOR_CACHE_HIT_USD_PER_MILLION"];

const BLANK = { provider: "", model: "", baseUrl: "", apiKey: "", thinking: "auto" as const, inputUsdPerMillion: "", outputUsdPerMillion: "", cacheHitUsdPerMillion: "" };

let directory = "";
let settingsFile = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "codebase-tutor-llm-settings-"));
  settingsFile = join(directory, "llm-settings.json");
  process.env.TUTOR_LLM_SETTINGS_FILE = settingsFile;
  setLlmRuntimeSettings(BLANK);
});

afterEach(() => {
  // 先把内存态清干净再删 TUTOR_LLM_SETTINGS_FILE：反过来的话这次清理会写到默认落点 ~/.codebase-tutor/，
  // 等于测试在用户机上凭空造了一份 LLM 设置文件（写出来的第一轮就踩过这个）
  setLlmRuntimeSettings(BLANK);
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

    // 换成官方 openai 且 .env 也没写端点：才回到该协议默认
    delete process.env.TUTOR_OPENAI_URL;
    setLlmRuntimeSettings({ provider: "openai", baseUrl: "" });
    expect(effectiveLlmConfig()).toMatchObject({ provider: "openai", model: "gui-model", baseUrl: "https://api.openai.com/v1", hasApiKey: true });
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

describe("单价三档（界面上配、立即生效）", () => {
  it("normalizeRate：空串=回落 .env，数字串与数字都收，负数/乱码/布尔一律拒", () => {
    expect(normalizeRate("")).toBe("");
    expect(normalizeRate("  0.28 ")).toBe("0.28");
    expect(normalizeRate(1.1)).toBe("1.1");
    expect(normalizeRate("0")).toBe("0");
    expect(normalizeRate("-3")).toBeUndefined();
    expect(normalizeRate("abc")).toBeUndefined();
    expect(normalizeRate("1e999")).toBeUndefined(); // Infinity 不是单价，是 NaN 的前身
    expect(normalizeRate(undefined)).toBeUndefined();
    expect(normalizeRate(true)).toBeUndefined();
  });

  it("部分更新：只改输出单价时，输入单价与服务商字段都不被清掉", () => {
    setLlmRuntimeSettings({ provider: "openai-compatible", inputUsdPerMillion: "0.28" });
    setLlmRuntimeSettings({ outputUsdPerMillion: "1.1" });
    expect(getLlmRuntimeSettings()).toMatchObject({ provider: "openai-compatible", inputUsdPerMillion: "0.28", outputUsdPerMillion: "1.1" });
  });

  it("填进去的单价落盘，重启后从磁盘读回来（界面上配完不该只活这一次会话）", () => {
    setLlmRuntimeSettings({ inputUsdPerMillion: "0.28", outputUsdPerMillion: "1.1", cacheHitUsdPerMillion: "0.028" });
    const saved = readFileSync(settingsFile, "utf8");
    expect(JSON.parse(saved) as Record<string, unknown>).toMatchObject({ inputUsdPerMillion: "0.28", outputUsdPerMillion: "1.1", cacheHitUsdPerMillion: "0.028" });

    // 模拟重启：清空内存态（注意这会把文件一起覆盖，所以先把上面那份内容写回去充当「上次保存的配置」），
    // 再走 boot 里那一步 restore——验的是「磁盘上的单价能不能活到下一个进程」
    setLlmRuntimeSettings({ inputUsdPerMillion: "", outputUsdPerMillion: "", cacheHitUsdPerMillion: "" });
    writeFileSync(settingsFile, saved, "utf8");
    expect(restoreLlmRuntimeSettings()).toMatchObject({ inputUsdPerMillion: "0.28", outputUsdPerMillion: "1.1", cacheHitUsdPerMillion: "0.028" });
  });

  it("配置文件被别的工具写脏时丢掉该项（回落 .env），而不是把负数带进内存", () => {
    process.env.TUTOR_INPUT_USD_PER_MILLION = "0.4";
    writeFileSync(settingsFile, JSON.stringify({ inputUsdPerMillion: "-3", outputUsdPerMillion: "abc", cacheHitUsdPerMillion: 0.028 }), "utf8");
    const restored = restoreLlmRuntimeSettings();
    expect(restored.inputUsdPerMillion).toBe("");
    expect(restored.outputUsdPerMillion).toBe("");
    expect(restored.cacheHitUsdPerMillion).toBe("0.028");
    // 丢掉之后 .env 那条回落链还在（单价的优先级只有两层，别在内存里再造第三层）
    expect(process.env.TUTOR_INPUT_USD_PER_MILLION).toBe("0.4");
  });

  it("对外视图带得出单价：它不是密钥，掩码只给 apiKey 那个字段", () => {
    setLlmRuntimeSettings({ apiKey: "sk-super-secret-value", inputUsdPerMillion: "0.28" });
    const view = publicLlmSettings() as Record<string, unknown>;
    expect(view.inputUsdPerMillion).toBe("0.28");
    expect(view.apiKey).toBeUndefined();
    expect(view.apiKeyMasked).toContain("*");
  });
});
