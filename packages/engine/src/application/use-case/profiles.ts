/** LLM 配置：列表、保存、删除、切换。切换前做一次最小连通性检查，失败不切换。 */
import { llmProfileStore, llmProvider, llmRuntime } from "../../infrastructure/composition-root.js";

export type ProfileFailure = "not-found" | "preflight" | "invalid";
export type ProfileResult<T> = { ok: true; value: T } | { ok: false; failure: ProfileFailure; message: string };

type ProfileView = ReturnType<typeof llmProfileStore.publicProfileView>;
type LlmProfile = ReturnType<typeof llmProfileStore.readProfileFile>["profiles"][number];

/** 第一次打开时把当前生效的连接填成一条配置，用户不必从空白开始。 */
export function ensureDefaultProfile(): void {
  if (llmProfileStore.readProfileFile().profiles.length) return;
  const runtime = llmRuntime.getLlmRuntimeSettings();
  const profile = llmProfileStore.upsertProfile({
    name: "默认配置",
    provider: runtime.provider,
    model: runtime.model,
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
    inputUsdPerMillion: runtime.inputUsdPerMillion,
    outputUsdPerMillion: runtime.outputUsdPerMillion,
    cacheHitUsdPerMillion: runtime.cacheHitUsdPerMillion
  });
  llmProfileStore.setActiveProfile(profile.id);
}

export function listProfilesUseCase(): ProfileView {
  ensureDefaultProfile();
  return llmProfileStore.publicProfileView();
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
  llmProfileStore.upsertProfile(input);
  return { ok: true, value: llmProfileStore.publicProfileView() };
}

/** 把当前运行时设置存成一套新配置。 */
export function captureCurrentProfileUseCase(name: string): ProfileResult<ProfileView> {
  const current = llmRuntime.getLlmRuntimeSettings();
  llmProfileStore.upsertProfile({
    name: name.trim() || "当前配置",
    provider: current.provider,
    model: current.model,
    baseUrl: current.baseUrl,
    apiKey: current.apiKey,
    inputUsdPerMillion: current.inputUsdPerMillion,
    outputUsdPerMillion: current.outputUsdPerMillion,
    cacheHitUsdPerMillion: current.cacheHitUsdPerMillion
  });
  return { ok: true, value: llmProfileStore.publicProfileView() };
}

export function deleteProfileUseCase(id: string): ProfileResult<ProfileView> {
  if (!llmProfileStore.removeProfile(id)) return { ok: false, failure: "not-found", message: "这套配置不存在。" };
  return { ok: true, value: llmProfileStore.publicProfileView() };
}

/** 一次最小请求：能收到回复才算连通；超时阈值在创建 provider 时给定。 */
async function preflight(profile: LlmProfile): Promise<string | undefined> {
  const provider = llmProvider.createLlmProvider({
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
  const stored = input.id ? llmProfileStore.readProfileFile().profiles.find((item) => item.id === input.id) : undefined;
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
  const profile = llmProfileStore.readProfileFile().profiles.find((item) => item.id === id);
  if (!profile) return { ok: false, failure: "not-found", message: "这套配置不存在。" };
  const failure = await preflight(profile);
  if (failure) return { ok: false, failure: "preflight", message: `连接失败：${failure}（未切换）` };
  // 只覆盖连接与计价；思考档位、超时留作全局设置
  llmRuntime.setLlmRuntimeSettings({
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    inputUsdPerMillion: profile.inputUsdPerMillion,
    outputUsdPerMillion: profile.outputUsdPerMillion,
    cacheHitUsdPerMillion: profile.cacheHitUsdPerMillion
  });
  llmProfileStore.setActiveProfile(profile.id);
  return { ok: true, value: llmProfileStore.publicProfileView() };
}
