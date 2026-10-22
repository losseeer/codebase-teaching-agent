import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { LlmTool } from "../llm/provider.js";
import { hash } from "../identity.js";
import { maskSecrets } from "../security/secrets.js";

/**
  MCP 客户端：把外部 MCP server 的工具接进产品 agent 的工具循环。
  只做产品 agent 读外部这一个方向；外部要读引擎就直接打那几条只读路由。

  三条规矩：

  1. 默认关闭。配置文件不存在 = 一条外部工具都不给，工具清单与系统提示词逐字不变。
     每条外部工具的 schema 都要进每一轮请求的 token，还会改前缀缓存的形状。
  2. 配置文件照客户端生态的通用形状：顶层 `mcpServers`，一个 server 一段（`command` / `args` / `env`，
     关掉用 `disabled`），把任何一份 MCP README 里的片段贴过来就能用。白名单用 `allowedTools`
     （取值与 Claude Code 那套工具 id 同形：`mcp__<server>__<tool>`，写裸工具名也认）。
     没写 `allowedTools` = 该 server 报上来的工具全部进模型手上；写了就只认清单。
  3. 正文不进任何日志。发出去的参数与拿回来的内容只记 `chars + hash`（与 `code_egress` 同一口径：
     报「出过门没有、是哪一版」，不另开一个泄露面）。返回内容进模型前先过一次密钥筛。
*/

export interface McpServerConfig {
  /** 配置里 `mcpServers` 的键名，进工具名前缀：`mcp__<name>__<tool>`。 */
  name: string;
  /** 本地 stdio server 的启动命令（客户端生态的通用形状：command + args + env）。 */
  command: string;
  args?: string[];
  cwd?: string;
  /** 传给子进程的环境变量。值从不回显、从不落日志（第三方 server 的密钥常放这里）。 */
  env?: Record<string, string>;
  /**
    工具白名单。取值两种写法都接：Claude Code 那种完整 id（`mcp__<server>__<tool>`）或裸工具名。
    没写 = 该 server 报上来的工具全部开放——第三方程序做了什么我们看不见，这一格是唯一的收口。
  */
  allowedTools?: string[];
}

/** 配置里一条原始条目（`mcpServers` 的值）。`url` / `type` / `headers` 是远程 server 那套写法，本引擎目前不接。 */
interface RawServerEntry {
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
  allowedTools?: unknown;
  tools?: unknown;
  disabled?: unknown;
  type?: unknown;
  url?: unknown;
  headers?: unknown;
}

/** 一次外部调用的审计形状（`mcp_call` 事件的 payload）。 */
export interface McpCallAudit {
  server: string;
  tool: string;
  /** 发给 server 的参数：只记字符数与指纹，正文不落盘。 */
  argsChars: number;
  argsHash: string;
  /** 交回模型的字符数（密钥筛与上限裁完之后）。 */
  resultChars: number;
  /** 密钥筛隐去了几处。`0` = 扫过零命中，与「没扫」是两个读数。 */
  masked: number;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface ExternalSurface {
  /** 已带 `mcp__server__tool` 前缀、可以直接进 provider 请求的清单。 */
  tools: LlmTool[];
  /** 连不上/被跳过的 server 与原因：这是读数，要能在界面上问出来。 */
  errors: { server: string; reason: string }[];
  /** 调一次。永不抛：失败回一句给模型看的实话 + 审计记录（抛出去会毁掉整个回合）。 */
  call: (name: string, argumentsJson: string) => Promise<{ text: string; audit: McpCallAudit }>;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** 单次外部调用的墙钟上限：外部 server 是别人写的，超时必须有默认值。每次调用现读（改环境变量不必重启引擎，测试也靠它压到一秒）。 */
function timeoutMs(): number {
  return Math.max(1_000, Number(process.env.TUTOR_MCP_TIMEOUT_MS ?? 20_000) || 20_000);
}
/** 交回模型的字符上限（超出截断并留声明；工具结果随后会被 micro_compact 再压一次）。 */
const RESULT_CHARS = 8_000;

export function mcpConfigFile(): string {
  return process.env.TUTOR_MCP_SETTINGS_FILE?.trim() || join(homedir(), ".codebase-tutor", "mcp.json");
}

export function readMcpConfigs(file = mcpConfigFile()): { servers: McpServerConfig[]; skipped: { server: string; reason: string }[] } {
  if (!existsSync(file)) return { servers: [], skipped: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { servers: [], skipped: [{ server: "-", reason: "配置文件不是合法 JSON" }] };
  }
  const map = (parsed as { mcpServers?: unknown; servers?: unknown }).mcpServers ?? (parsed as { servers?: unknown }).servers;
  if (!map || typeof map !== "object" || Array.isArray(map)) return { servers: [], skipped: [{ server: "-", reason: "配置里要有顶层 mcpServers（一个 server 一段，别写成数组）" }] };
  const servers: McpServerConfig[] = [];
  const skipped: { server: string; reason: string }[] = [];
  for (const [name, raw] of Object.entries(map as Record<string, RawServerEntry>)) {
    if (!NAME_PATTERN.test(name)) {
      // 名字要拼进工具名 `mcp__<name>__<tool>`，服务商按 ASCII 校验工具名：不合形就在配置层拒掉并说原因
      skipped.push({ server: name, reason: "server 名不合形（小写字母/数字/下划线/连字符，首字符不能是 - 或 _，≤40）" });
      continue;
    }
    if (name.includes("__")) {
      // 工具名拼成 `mcp__<server>__<tool>`：server 名里再有 `__` 就没法从暴露名反解，两台 server 撞名时调用会落到错的那台
      skipped.push({ server: name, reason: "server 名不能含连续下划线（与 `mcp__` 前缀冲突）" });
      continue;
    }
    if (raw?.disabled === true) { skipped.push({ server: name, reason: "配置里 disabled=true（没接）" }); continue; }
    if (typeof raw?.url === "string" && raw.url.trim()) { skipped.push({ server: name, reason: "远程 server（url/type）没接：外部调用的出境记账与 fail-closed 是前置（#175）" }); continue; }
    if (typeof raw?.command !== "string" || !raw.command.trim()) { skipped.push({ server: name, reason: "本地 server 缺 command" }); continue; }
    const allowed = Array.isArray(raw.allowedTools) ? raw.allowedTools : Array.isArray(raw.tools) ? raw.tools : [];
    // 「没写白名单」与「写了空数组」是两个读数：空数组是用户显式要「这台一个都不给」，不能退成全放行
    const declared = raw.allowedTools !== undefined || raw.tools !== undefined;
    servers.push({
      name,
      command: raw.command,
      ...(Array.isArray(raw.args) ? { args: raw.args.map(String) } : {}),
      ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
      ...(raw.env && typeof raw.env === "object" ? { env: Object.fromEntries(Object.entries(raw.env as Record<string, unknown>).map(([key, value]) => [key, String(value)])) } : {}),
      ...(declared ? { allowedTools: allowed.map(String) } : {})
    });
  }
  return { servers, skipped };
}

interface Connected {
  client: Client;
  server: string;
  /** 这台 server 报上来的全部工具；白名单每轮现裁，见 `externalToolSurface`。 */
  tools: LlmTool[];
  /** 暴露名 → server 侧的原始工具名。 */
  origin: Map<string, string>;
  /** 建这条连接时用的启动配置指纹：改了 command/args/cwd/env 就要重连，留着旧连接等于拿旧配置办事。 */
  signature: string;
}

/** 连接池：按 server 名惰性连一次并缓存这条 promise。连成功的一直复用；连不上、调用时发现连接已死、或启动配置变了的，把这一项摘掉，下一个回合重连——既不留僵尸子进程，也不让一次故障被永久钉成「每轮都超时」。 */
const pool = new Map<string, Promise<Connected | undefined>>();

function configSignature(config: McpServerConfig): string {
  return hash(JSON.stringify({ command: config.command, args: config.args ?? [], cwd: config.cwd ?? "", env: config.env ?? {} }));
}

/** 白名单两种写法都认：完整 id 按这台 server 的名字剥前缀（server 名允许下划线），裸工具名照原样比。`undefined` = 没写白名单 = 全部放行。 */
function allowedNames(config: McpServerConfig): Set<string> | undefined {
  if (!config.allowedTools) return undefined;
  const prefix = `mcp__${config.name}__`;
  return new Set(config.allowedTools.map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry)));
}

async function connect(config: McpServerConfig): Promise<Connected | undefined> {
  const client = new Client({ name: "codebase-tutor-engine", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: config.command,
    ...(config.args?.length ? { args: config.args } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) }
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools: LlmTool[] = [];
    const origin = new Map<string, string>();
    for (const tool of listed.tools) {
      const name = `mcp__${config.name}__${tool.name}`;
      const { $schema: _ignored, ...parameters } = (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>;
      tools.push({ name, description: tool.description ? `【外部 ${config.name}】${tool.description}` : `【外部 ${config.name}】${tool.name}`, parameters: parameters as LlmTool["parameters"] });
      origin.set(name, tool.name);
    }
    return { client, server: config.name, tools, origin, signature: configSignature(config) };
  } catch {
    await client.close().catch(() => undefined);
    return undefined;
  }
}

function previewOf(argumentsJson: string): { argsChars: number; argsHash: string } {
  const text = argumentsJson || "{}";
  return { argsChars: text.length, argsHash: hash(text).slice(0, 12) };
}

/** 超时与「调用本身失败」是两个读数：前者是 server 慢，后者是连接/子进程已经死了，处置完全不同。 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" | "failed" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, reason: "failed" as const })),
    new Promise<{ ok: false; reason: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), ms); })
  ]);
  clearTimeout(timer);
  return outcome;
}

/**
  现做本轮的外部工具面。没有配置文件就回 `undefined`——调用方据此一个工具都不加，
  而不是加一个「外部工具不可用」的空节点（那等于每轮多一句没人用的说明）。
*/
export async function externalToolSurface(): Promise<ExternalSurface | undefined> {
  const { servers, skipped } = readMcpConfigs();
  // 配置里删掉的 server 先收尾：这一轮一个都不配时也不能留子进程
  const wanted = new Set(servers.map((config) => config.name));
  for (const [name, pending] of [...pool]) {
    if (wanted.has(name)) continue;
    pool.delete(name);
    void pending.then((entry) => entry?.client.close().catch(() => undefined), () => undefined);
  }
  if (!servers.length && !skipped.length) return undefined;
  const connected: Connected[] = [];
  const errors = skipped.map((entry) => ({ server: entry.server, reason: entry.reason }));
  for (const config of servers) {
    const signature = configSignature(config);
    let cached = pool.get(config.name);
    const existing = await cached;
    if (existing && existing.signature !== signature) {
      // 启动配置变了就连新的，否则改了 command/args/env 要重启引擎才生效
      void existing.client.close().catch(() => undefined);
      pool.delete(config.name);
      cached = undefined;
    }
    if (!cached) {
      cached = connect(config).catch(() => undefined);
      pool.set(config.name, cached);
    }
    const entry = await cached;
    if (!entry) { errors.push({ server: config.name, reason: "连不上（子进程起不来或 initialize 失败）" }); pool.delete(config.name); continue; }
    // 白名单每轮现裁：连接里存的是这台报上来的全部工具，改了 `allowedTools` 不必重启就生效
    const allowed = allowedNames(config);
    const tools = allowed ? entry.tools.filter((tool) => allowed.has(entry.origin.get(tool.name) ?? tool.name)) : entry.tools;
    if (!tools.length) errors.push({ server: config.name, reason: allowed ? "连上了但它报的工具都不在白名单里" : "连上了，它一个工具都没报" });
    connected.push({ client: entry.client, server: entry.server, tools, origin: new Map(tools.map((tool) => [tool.name, entry.origin.get(tool.name) as string])), signature: entry.signature });
  }
  const tools = connected.flatMap((entry) => entry.tools);
  if (!tools.length) return errors.length ? { tools: [], errors, call: async (name, argumentsJson) => { const base = { server: name.split("__")[1] ?? "-", tool: name, ...previewOf(argumentsJson) }; return { text: "外部工具当前不可用。", audit: { ...base, resultChars: 0, masked: 0, ok: false, ms: 0, error: "no_tool" } }; } } : undefined;
  return {
    tools,
    errors,
    call: async (name, argumentsJson) => {
      const entry = connected.find((candidate) => candidate.origin.has(name));
      const started = Date.now();
      const base = { server: entry?.server ?? name.split("__")[1] ?? "-", tool: entry?.origin.get(name) ?? name, ...previewOf(argumentsJson) };
      if (!entry) return { text: `未知外部工具「${name}」。`, audit: { ...base, resultChars: 0, masked: 0, ok: false, ms: Date.now() - started, error: "unknown_tool" } };
      let args: Record<string, unknown> = {};
      try {
        args = (argumentsJson ? JSON.parse(argumentsJson) : {}) as Record<string, unknown>;
      } catch {
        const text = `给外部工具「${entry.server}/${entry.origin.get(name)}」的参数不是合法 JSON，这次没执行。`;
        return { text, audit: { ...base, resultChars: text.length, masked: 0, ok: false, ms: Date.now() - started, error: "bad_arguments" } };
      }
      const limit = timeoutMs();
      const outcome = await withTimeout(entry.client.callTool({ name: entry.origin.get(name) as string, arguments: args }), limit);
      const ms = Date.now() - started;
      if (!outcome.ok) {
        // 调用本身失败 = 这条连接大概率已经死了：从池里摘掉，下一个回合重连（留着就是每轮都报超时）。
        // 摘池不等于收尾——子进程是 SDK 在 `close()` 里杀的，不关掉它下一回合重开一条，旧的就在机器上挂到引擎退出。
        if (outcome.reason === "failed") {
          void entry.client.close().catch(() => undefined);
          pool.delete(entry.server);
        }
        const text = outcome.reason === "timeout"
          ? `外部工具「${entry.server}/${entry.origin.get(name)}」${limit / 1000}s 没回话（这台 server 是外部程序，可能卡住了）。请基于已有信息回答，并说明这一项没核实。`
          : `外部工具「${entry.server}/${entry.origin.get(name)}」这条连接没打通（子进程退了或已经断了）。这一项没核实，请基于已有信息回答。`;
        return { text, audit: { ...base, resultChars: text.length, masked: 0, ok: false, ms, error: outcome.reason } };
      }
      const result = outcome.value;
      const parts = (result.content ?? []) as { type?: string; text?: string }[];
      const texts = parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string);
      const dropped = parts.length - texts.length;
      const flagged = Boolean((result as { isError?: boolean }).isError);
      const raw = `${flagged ? "外部工具回了错误：\n" : ""}${texts.join("\n")}${dropped > 0 ? `\n…（另有 ${dropped} 段非文本内容未交回）` : ""}`;
      const clipped = raw.length > RESULT_CHARS ? `${raw.slice(0, RESULT_CHARS)}\n…（外部返回已截断，原 ${raw.length} 字。）` : raw;
      const masked = maskSecrets(clipped);
      return { text: masked.text, audit: { ...base, resultChars: masked.text.length, masked: masked.masked, ok: !flagged, ms, ...(flagged ? { error: "server_reported_error" } : {}) } };
    }
  };
}

/** 收摊：关连接、清池。引擎退出与测试收尾都走这里（子进程不能留在机器上）。 */
export async function closeExternalTools(): Promise<void> {
  const entries = await Promise.all([...pool.values()]);
  pool.clear();
  for (const entry of entries) await entry?.client.close().catch(() => undefined);
}

/** 清空连接池并把子进程关掉：测试收尾用（配置本身每轮现读，增删 server、改白名单与改启动配置都下一回合生效，没有单独的热加载入口）。 */
export function resetExternalTools(): void {
  const pending = [...pool.values()];
  pool.clear();
  for (const entry of pending) void entry.then((connected) => connected?.client.close().catch(() => undefined), () => undefined);
}
