import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
  API key 认证：**这是引擎第一次有「谁在调用」这个概念**。
  刻意不做登录、不做用户表——今天的产品没有任何身份体系，先有闸再谈角色。
  `name` 就是暂时的 userId（进 trace 与两条日志线），将来真接用户体系时换成真 id，
  日志字段是字符串，历史行不用重刷。

  三条口径：
  - **没配任何 key = 认证关闭**（本机单用户的默认形态，GUI 不用改一行就能连）。
    这条必须开机就喊出来：一个"有名字但没有闸"的守卫，和预算闸门没配单价是同一类事故（见 §36.6）。
  - key 只存**哈希**在内存里比对？不——文件里存的就是明文 key（本机 0600），比对用哈希后定长比较，
    目的是**不让 timing 差异泄露前缀**，不是防文件泄露（文件泄露就已经是终局）。
  - `repositories` 是这张 key 能开哪些仓（id 或 `*`）。**跨仓工具也必须走同一份 ACL**，
    否则「A 仓的对话把 B 仓的源码读进 prompt」就成了越权口子。
 */
export interface ApiKey {
  /** 谁发的、给谁用的名字：进日志的 actor 字段 */
  name: string;
  key: string;
  /** 能访问的仓库 id；`["*"]` 或省略 = 全部 */
  repositories: string[];
}

export interface AuthResult {
  name: string;
  repositories: string[];
}

function keysFile(): string {
  return process.env.TUTOR_API_KEYS_FILE ?? join(homedir(), ".codebase-tutor", "api-keys.json");
}

let cache: { file: string; mtimeMs: number; keys: ApiKey[] } | undefined;

function parse(value: unknown): ApiKey[] {
  if (!Array.isArray(value)) return [];
  const keys: ApiKey[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { key?: unknown; name?: unknown; repositories?: unknown };
    if (typeof record.key !== "string" || record.key.length < 16) continue; // 短 key 一律不收：它挡不住任何东西
    keys.push({
      key: record.key,
      name: typeof record.name === "string" && record.name ? record.name : "unnamed-key",
      repositories: Array.isArray(record.repositories) ? record.repositories.filter((entry): entry is string => typeof entry === "string") : ["*"]
    });
  }
  return keys;
}

/** 每次调用现读文件（statSync 级别）：改 key 不该需要重启引擎，而导入/对话都是低频动作。 */
export function loadApiKeys(): ApiKey[] {
  const file = keysFile();
  if (!existsSync(file)) return [];
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return [];
  }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.keys;
  let keys: ApiKey[] = [];
  try {
    keys = parse((JSON.parse(readFileSync(file, "utf8")) as { keys?: unknown }).keys);
  } catch {
    keys = []; // 坏文件按「没配 key」处理：认证退回关闭，而不是把整个引擎锁死
  }
  cache = { file, mtimeMs, keys };
  return keys;
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** 认证是否生效。false = 本机模式（无 key 文件或文件里没有可用 key）。 */
export function authEnabled(): boolean {
  return loadApiKeys().length > 0;
}

/** 比对一张 key：定长时间比较，命中即回身份。 */
export function authenticate(presented: string | undefined): AuthResult | undefined {
  if (!presented) return undefined;
  const candidate = digest(presented);
  for (const entry of loadApiKeys()) {
    if (candidate.length === digest(entry.key).length && timingSafeEqual(candidate, digest(entry.key))) {
      return { name: entry.name, repositories: entry.repositories };
    }
  }
  return undefined;
}

/** 这张 key 能不能碰这个仓。`*` = 全部。 */
export function allowsRepository(auth: AuthResult, repositoryId: string): boolean {
  return auth.repositories.includes("*") || auth.repositories.includes(repositoryId);
}

/** 从请求头取 key：`x-api-key` 或 `Authorization: Bearer …` 两种写法都收。 */
export function presentedKey(header: string | string[] | undefined, authorization: string | string[] | undefined): string | undefined {
  const direct = Array.isArray(header) ? header[0] : header;
  if (direct) return direct;
  const bearer = Array.isArray(authorization) ? authorization[0] : authorization;
  return bearer?.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : undefined;
}
