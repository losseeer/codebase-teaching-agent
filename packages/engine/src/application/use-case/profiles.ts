/** LLM 配置：列表、保存、删除、切换。切换前做一次最小连通性检查，失败不切换。 */
import { createLlmProvider, resolveLlmConfig } from "../../adapter/outbound/llm/provider.js";
import { publicProfileView, readProfileFile, removeProfile, setActiveProfile, upsertProfile, type LlmProfile } from "../../adapter/outbound/llm/profiles.js";
import { getLlmRuntimeSettings, setLlmRuntimeSettings } from "../../adapter/outbound/llm/runtime.js";

export type ProfileFailure = "not-found" | "preflight" | "invalid";
export type ProfileResult<T> = { ok: true; value: T } | { ok: false; failure: ProfileFailure; message: string };

type ProfileView = ReturnType<typeof publicProfileView>;

/** 第一次打开时把当前生效的连接填成一条配置，用户不必从空白开始。 */
export function ensureDefaultProfile(): void {
  if (readProfileFile().profiles.length) return;
  const runtime = getLlmRuntimeSettings();
  const fallback = resolveLlmConfig({});
  const profile = upsertProfile({
    name: "默认配置",
    provider: runtime.provider || fallback.provider || "",
    model: runtime.model || fallback.model || "",
    baseUrl: runtime.baseUrl || fallback.baseUrl || "",
    // 运行时里存着明文才带上；来自 .env 的密钥不复制出来，激活时照旧回落
    apiKey: runtime.apiKey,
    inputUsdPerMillion: runtime.inputUsdPerMillion,
    outputUsdPerMillion: runtime.outputUsdPerMillion,
    cacheHitUsdPerMillion: runtime.cacheHitUsdPerMillion
  });
  setActiveProfile(profile.id);
}

export function listProfilesUseCase(): ProfileView {
  ensureDefaultProfile();
  return publicProfileView();
}

export function saveProfileUseCase(input: {
  id?: string;
  name?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  inputUsdPerMillion?: string;
  outputUsdPerMillion?: string;
  cacheHitUsdPerMillion?: string;
}): ProfileResult<ProfileView> {
  if (input.name !== undefined && !input.name.trim()) {
    return { ok: false, failure: "invalid", message: "配置名不能为空。" };
  }
  upsertProfile(input);
  return { ok: true, value: publicProfileView() };
}

/** 把当前运行时设置存成一套新配置。 */
export function captureCurrentProfileUseCase(name: string): ProfileResult<ProfileView> {
  const current = getLlmRuntimeSettings();
  upsertProfile({
    name: name.trim() || "当前配置",
    provider: current.provider,
    model: current.model,
    baseUrl: current.baseUrl,
    apiKey: current.apiKey,
    inputUsdPerMillion: current.inputUsdPerMillion,
    outputUsdPerMillion: current.outputUsdPerMillion,
    cacheHitUsdPerMillion: current.cacheHitUsdPerMillion
  });
  return { ok: true, value: publicProfileView() };
}

export function deleteProfileUseCase(id: string): ProfileResult<ProfileView> {
  if (!removeProfile(id)) return { ok: false, failure: "not-found", message: "这套配置不存在。" };
  return { ok: true, value: publicProfileView() };
}

/** 一次最小请求：能收到回复才算连通；超时阈值在创建 provider 时给定。 */
async function preflight(profile: LlmProfile): Promise<string | undefined> {
  const provider = createLlmProvider({
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    timeoutMs: "10000"
  });
  if (!provider) return "配置不完整（缺服务商、模型或密钥）";
  try {
    await provider.complete({ system: "连通性检查：只回复 ok。", user: "ping", maxTokens: 16, temperature: 0, thinking: "off", scene: "profile.preflight" });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "连接失败";
  }
}

/** 表单里的「测试连接」：用给定参数或已存配置补全后跑一次预检，不改任何状态。 */
export async function testProfileUseCase(input: {
  id?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const stored = input.id ? readProfileFile().profiles.find((item) => item.id === input.id) : undefined;
  const profile: LlmProfile = {
    id: input.id ?? "test",
    name: "",
    provider: (input.provider ?? stored?.provider ?? "").trim(),
    model: (input.model ?? stored?.model ?? "").trim(),
    baseUrl: (input.baseUrl ?? stored?.baseUrl ?? "").trim(),
    apiKey: (input.apiKey ?? stored?.apiKey ?? "").trim(),
    inputUsdPerMillion: "",
    outputUsdPerMillion: "",
    cacheHitUsdPerMillion: ""
  };
  const failure = await preflight(profile);
  return failure ? { ok: false, message: failure } : { ok: true };
}

export async function activateProfileUseCase(id: string): Promise<ProfileResult<ProfileView>> {
  const profile = readProfileFile().profiles.find((item) => item.id === id);
  if (!profile) return { ok: false, failure: "not-found", message: "这套配置不存在。" };
  const failure = await preflight(profile);
  if (failure) return { ok: false, failure: "preflight", message: `连接失败：${failure}（未切换）` };
  // 只覆盖连接与计价；思考档位、超时留作全局设置
  setLlmRuntimeSettings({
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    inputUsdPerMillion: profile.inputUsdPerMillion,
    outputUsdPerMillion: profile.outputUsdPerMillion,
    cacheHitUsdPerMillion: profile.cacheHitUsdPerMillion
  });
  setActiveProfile(profile.id);
  return { ok: true, value: publicProfileView() };
}
