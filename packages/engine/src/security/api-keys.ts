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
  - `repositories` 是这张 key 能开哪些仓（id 或 `*`）。**跨仓工具也必须走同一份 ACL**——
    判据与「为什么这是唯一安全边界」写在 server.ts 的 `crossRepoFor`，那里离检查最近。
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

/**
  闸门状态三档，**坏文件不能算「没闸门」**：
  - `off` = 压根没有 key 文件，或文件是一份合法的空清单（用户自己把闸关了）。
  - `on` = 至少一张可用 key。
  - `broken` = 文件在，但读不出来（JSON 坏、结构不对），**或写了 key 却一张都不可用**（全是短 key）。
    这一档以前按 `off` 处理，等于「编辑口令文件编辑到一半 = 整机免鉴权」，
    与 §36.6 那条纪律正好相反：有闸门的名字就必须看得见闸门的状态。现在按 fail-closed 走 503。
*/
export type AuthState = "off" | "on" | "broken";

interface Loaded {
  state: AuthState;
  keys: ApiKey[];
}

const EMPTY: Loaded = { state: "off", keys: [] };

function keysFile(): string {
  return process.env.TUTOR_API_KEYS_FILE ?? join(homedir(), ".codebase-tutor", "api-keys.json");
}

let cache: { file: string; mtimeMs: number; loaded: Loaded } | undefined;

/** 返回 null = 这份清单读不出来或形状不对（区别于「合法但一条 key 都没有」）。 */
function parse(value: unknown): ApiKey[] | null {
  if (!Array.isArray(value)) return null;
  const keys: ApiKey[] = [];
  for (const item of value) {
    // 单条写坏 = 跳过那一条，别把整张闸关掉：其余有效 key 的持有人还在正常工作。
    // 「跳过之后一条都不剩」才是闸 intended 却失效，那一路在 `load()` 里判 broken。
    if (!item || typeof item !== "object") continue;
    const record = item as { key?: unknown; name?: unknown; repositories?: unknown };
    if (typeof record.key !== "string" || record.key.length < 16) continue; // 缺 key / 短 key：它挡不住任何东西
    keys.push({
      key: record.key,
      name: typeof record.name === "string" && record.name ? record.name : "unnamed-key",
      repositories: Array.isArray(record.repositories) ? record.repositories.filter((entry): entry is string => typeof entry === "string") : ["*"]
    });
  }
  return keys;
}

function load(): Loaded {
  const file = keysFile();
  if (!existsSync(file)) return EMPTY;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return { state: "broken", keys: [] }; // 文件刚消失又被建起来、权限被改：宁可判成闸坏了，也不静默放行
  }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.loaded;
  let loaded: Loaded;
  const raw = (() => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as { keys?: unknown };
    } catch {
      return null;
    }
  })();
  const listed = raw && typeof raw === "object" && "keys" in raw ? parse(raw.keys) : null;
  if (listed === null) {
    loaded = { state: "broken", keys: [] };
  } else if (listed.length) {
    loaded = { state: "on", keys: listed };
  } else {
    // 能走到这里只有两种：**清单本来就是空的**（用户主动关闸，合法），
    // 以及「写了条目但一张都用不了」（全是短 key）——后者是闸 intended 却失效，按 broken 拦死。
    const wanted = Array.isArray(raw?.keys) && raw.keys.length > 0;
    loaded = { state: wanted ? "broken" : "off", keys: [] };
  }
  cache = { file, mtimeMs, loaded };
  return loaded;
}

/** 每次调用现读文件（statSync 级别）：改 key 不该需要重启引擎，而导入/对话都是低频动作。 */
export function loadApiKeys(): ApiKey[] {
  return load().keys;
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** 闸门现在的状态（`/api/health` 与开机那两行日志都报这个，不再只报「启没启用」）。 */
export function authStateOf(): AuthState {
  return load().state;
}

/** 认证是否生效。false = 本机模式（无 key 文件或文件里没有可用 key）。 */
export function authEnabled(): boolean {
  return load().state === "on";
}

/** 比对一张 key：定长时间比较，命中即回身份。 */
export function authenticate(presented: string | undefined): AuthResult | undefined {
  if (!presented) return undefined;
  const candidate = digest(presented);
  for (const entry of loadApiKeys()) {
    // 两边都是 sha256 定长摘要，timingSafeEqual 的长度前提天然成立——这正是「哈希后比较」的目的
    if (timingSafeEqual(candidate, digest(entry.key))) {
      return { name: entry.name, repositories: entry.repositories };
    }
  }
  return undefined;
}

/**
  这个名字还在不在册——撤一张 key 之后，**已经建起来的长连接**（事件流、心跳）拿这个判据自摘。
  按名字而不是按 key：连接里不留口令明文，口令文件也只有名字这一项还能比对。
  闸门整体关着（本机模式）时恒为真，否则每条流都会在没口令的环境里被自己掐掉。
  */
export function stillIssued(name: string): boolean {
  const loaded = load();
  if (loaded.state !== "on") return true;
  return loaded.keys.some((entry) => entry.name === name);
}


/** 名单里有没有 `*`：「这张 key 不受仓名约束」这个含义只在这一处定义——按仓判据与「不受限能力」判据都读它，
    免得两处对 `*` 的理解漂开（`unrestricted` 与 `allowsRepository` 以前各写一份 `includes("*")`）。 */
export function hasWildcard(auth: AuthResult): boolean {
  return auth.repositories.includes("*");
}

/** 这张 key 能不能碰这个仓。`*` = 全部。 */
export function allowsRepository(auth: AuthResult, repositoryId: string): boolean {
  return hasWildcard(auth) || auth.repositories.includes(repositoryId);
}

/** 从请求头取 key：`x-api-key` 或 `Authorization: Bearer …` 两种写法都收。 */
export function presentedKey(header: string | string[] | undefined, authorization: string | string[] | undefined): string | undefined {
  const direct = Array.isArray(header) ? header[0] : header;
  if (direct) return direct;
  const bearer = Array.isArray(authorization) ? authorization[0] : authorization;
  return bearer?.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : undefined;
}
