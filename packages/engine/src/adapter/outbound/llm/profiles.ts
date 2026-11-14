/** 用户配置过的 LLM：连接 + 模型 + 单价。与运行时设置同目录落盘，权限 0600。 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { maskSecret, normalizeRate } from "./runtime.js";

export interface LlmProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  /** 明文只落本文件，界面只看到掩码。 */
  apiKey: string;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  cacheHitUsdPerMillion: string;
}

export interface ProfileFile {
  activeId: string;
  profiles: LlmProfile[];
}

const TEXT_FIELDS = ["name", "provider", "model", "baseUrl", "apiKey"] as const;
const RATE_FIELDS = ["inputUsdPerMillion", "outputUsdPerMillion", "cacheHitUsdPerMillion"] as const;

export function profilesPath(): string {
  return join(homedir(), ".codebase-tutor", "llm-profiles.json");
}

function blank(name = "新配置"): Omit<LlmProfile, "id"> {
  return {
    name, provider: "", model: "", baseUrl: "", apiKey: "",
    inputUsdPerMillion: "", outputUsdPerMillion: "", cacheHitUsdPerMillion: ""
  };
}

function normalizeProfile(raw: unknown): LlmProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return undefined;
  const profile: LlmProfile = { id, ...blank() };
  for (const key of TEXT_FIELDS) {
    if (typeof record[key] === "string") profile[key] = (record[key] as string).trim();
  }
  for (const key of RATE_FIELDS) {
    const rate = normalizeRate(record[key]);
    if (rate !== undefined) profile[key] = rate;
  }
  return profile;
}

export function readProfileFile(): ProfileFile {
  const file = profilesPath();
  if (!existsSync(file)) return { activeId: "", profiles: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { activeId?: unknown; profiles?: unknown };
    const profiles = Array.isArray(parsed.profiles)
      ? parsed.profiles.flatMap((item) => { const next = normalizeProfile(item); return next ? [next] : []; })
      : [];
    const activeId = typeof parsed.activeId === "string" && profiles.some((item) => item.id === parsed.activeId) ? parsed.activeId : (profiles[0]?.id ?? "");
    return { activeId, profiles };
  } catch {
    return { activeId: "", profiles: [] };
  }
}

export function writeProfileFile(next: ProfileFile): void {
  const file = profilesPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (error) {
    console.warn(`[llm] 配置文件没能落盘：path=${file} error=${String(error)}`);
  }
}

/** 界面视图：密钥只出掩码与是否已配置。 */
export function publicProfileView(): { activeId: string; profiles: Array<Omit<LlmProfile, "apiKey"> & { apiKeyMasked: string; hasApiKey: boolean }> } {
  const current = readProfileFile();
  return {
    activeId: current.activeId,
    profiles: current.profiles.map(({ apiKey, ...rest }) => ({ ...rest, apiKeyMasked: maskSecret(apiKey), hasApiKey: Boolean(apiKey) }))
  };
}

export function activeProfile(): LlmProfile | undefined {
  const current = readProfileFile();
  return current.profiles.find((item) => item.id === current.activeId);
}

export function upsertProfile(input: Partial<LlmProfile> & { id?: string }): LlmProfile {
  const current = readProfileFile();
  const existing = input.id ? current.profiles.find((item) => item.id === input.id) : undefined;
  const base: LlmProfile = existing ?? { id: `p_${randomUUID().slice(0, 8)}`, ...blank(`配置 ${String(current.profiles.length + 1)}`) };
  const next: LlmProfile = { ...base };
  for (const key of TEXT_FIELDS) {
    if (typeof input[key] === "string") next[key] = (input[key] as string).trim();
  }
  for (const key of RATE_FIELDS) {
    if (input[key] !== undefined) {
      const rate = normalizeRate(input[key]);
      if (rate !== undefined) next[key] = rate;
    }
  }
  const profiles = existing
    ? current.profiles.map((item) => (item.id === next.id ? next : item))
    : [...current.profiles, next];
  writeProfileFile({ activeId: current.activeId || next.id, profiles });
  return next;
}

export function removeProfile(id: string): boolean {
  const current = readProfileFile();
  const profiles = current.profiles.filter((item) => item.id !== id);
  if (profiles.length === current.profiles.length) return false;
  writeProfileFile({ activeId: current.activeId === id ? (profiles[0]?.id ?? "") : current.activeId, profiles });
  return true;
}

export function setActiveProfile(id: string): boolean {
  const current = readProfileFile();
  if (!current.profiles.some((item) => item.id === id)) return false;
  writeProfileFile({ ...current, activeId: id });
  return true;
}

/** 运行时设置变更后回写当前配置，避免界面显示与配置不一致。 */
export function syncActiveProfile(input: { provider: string; model: string; baseUrl: string; apiKey: string; inputUsdPerMillion: string; outputUsdPerMillion: string; cacheHitUsdPerMillion: string }): void {
  const current = activeProfile();
  if (!current) return;
  upsertProfile({ id: current.id, ...input });
}
