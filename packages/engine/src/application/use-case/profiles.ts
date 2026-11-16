/** LLM 配置：列表、保存、删除、切换。切换前做一次最小连通性检查，失败不切换。 */
import { llmCallLog, llmProfileStore, llmProvider, llmRuntime, llmThinking } from "../../infrastructure/composition-root.js";

export type ProfileFailure = "not-found" | "preflight" | "invalid" | "write-failed";
export type ProfileResult<T> = { ok: true; value: T; notice?: string } | { ok: false; failure: ProfileFailure; message: string };

const invalid = (message: string): ProfileResult<never> => ({ ok: false, failure: "invalid", message });
const writeFailed = (): ProfileResult<never> => ({ ok: false, failure: "write-failed", message: "配置文件没写成，改动没有保存。" });
const nameTaken = (name: string, id?: string): boolean =>
  llmProfileStore.readProfileFile().profiles.some((item) => item.name === name && item.id !== id);

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
  if (profile) llmProfileStore.setActiveProfile(profile.id);
}

export function listProfilesUseCase(): ProfileView {
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
  const name = input.name?.trim();
  if (input.name !== undefined && !name) return invalid("配置名不能为空。");
  if (name && nameTaken(name, input.id)) return invalid("同名配置已存在。");
  if (!llmProfileStore.upsertProfile(input)) return writeFailed();
  return { ok: true, value: llmProfileStore.publicProfileView() };
}

/** 把当前运行时设置存成一套新配置。 */
export function captureCurrentProfileUseCase(name: string): ProfileResult<ProfileView> {
  const current = llmRuntime.getLlmRuntimeSettings();
  const label = name.trim() || "当前配置";
  if (nameTaken(label)) return invalid("同名配置已存在。");
  if (!llmProfileStore.upsertProfile({
    name: label,
    provider: current.provider,
    model: current.model,
    baseUrl: current.baseUrl,
    apiKey: current.apiKey,
    inputUsdPerMillion: current.inputUsdPerMillion,
    outputUsdPerMillion: current.outputUsdPerMillion,
    cacheHitUsdPerMillion: current.cacheHitUsdPerMillion
  })) return writeFailed();
  return { ok: true, value: llmProfileStore.publicProfileView() };
}

export function deleteProfileUseCase(id: string): ProfileResult<ProfileView> {
  const file = llmProfileStore.readProfileFile();
  if (file.profiles.length <= 1) return invalid("至少要保留一套配置。");
  const wasActive = file.activeId === id;
  const outcome = llmProfileStore.removeProfile(id);
  if (outcome === "missing") return { ok: false, failure: "not-found", message: "这套配置不存在。" };
  if (outcome === "write-failed") return writeFailed();
  // 删的是当前配置：运行时一并清空，避免界面「没有配置」但实际还在用旧连接
  if (wasActive) {
    llmRuntime.setLlmRuntimeSettings({
      provider: "", model: "", baseUrl: "", apiKey: "",
      inputUsdPerMillion: "", outputUsdPerMillion: "", cacheHitUsdPerMillion: ""
    });
  }
  return { ok: true, value: llmProfileStore.publicProfileView() };
}

/** fetch 只报 "fetch failed" 时没法判断是 DNS、连接被拒还是超时：把底层 cause 带出来。 */
export function networkReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // undici 对禁止端口只抛 "bad port"，看不出是哪一段
  if (/^bad port$/i.test(error.message)) return "接口地址的端口被禁止（如 :9），请检查地址";
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const detail = typeof cause?.message === "string" ? cause.message.trim() : "";
  if (detail && code) return `${detail}（${code}）`;
  return code || detail || error.message;
}

/** 一次最小请求：能收到回复才算连通；超时阈值在创建 provider 时给定。 */
async function preflight(profile: LlmProfile): Promise<string | undefined> {
  const raw = llmProvider.createLlmProvider({
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    timeoutMs: "10000"
  });
  if (!raw) return "配置不完整（缺服务商、模型或密钥）";
  // 预检也要进工作日志：失败时才能查到是网络、密钥还是端点
  const provider = new llmCallLog.LoggingLlmProvider(raw, "probe");
  try {
    await provider.complete({ system: "连通性检查：只回复 ok。", user: "ping", maxTokens: 16, temperature: 0, thinking: "off", scene: "profile.preflight" });
    return undefined;
  } catch (error) {
    return networkReason(error);
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
  const thinking = llmRuntime.getLlmRuntimeSettings().thinking;
  const keepThinking = thinking === "auto" || llmThinking.isThinkingEffortSupported(profile.model, thinking);
  llmRuntime.setLlmRuntimeSettings({
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    inputUsdPerMillion: profile.inputUsdPerMillion,
    outputUsdPerMillion: profile.outputUsdPerMillion,
    cacheHitUsdPerMillion: profile.cacheHitUsdPerMillion,
    ...(keepThinking ? {} : { thinking: "auto" as const })
  });
  if (llmProfileStore.setActiveProfile(profile.id) !== "ok") {
    return { ok: false, failure: "write-failed", message: "已切换到该配置，但激活标记没能落盘：重启后会回退。" };
  }
  return {
    ok: true,
    value: llmProfileStore.publicProfileView(),
    ...(keepThinking ? {} : { notice: "思考档位已重置为「自动」：该模型不支持原档位。" })
  };
}
