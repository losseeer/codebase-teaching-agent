import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpCallAudit } from "@codebase-tutor/domain";
import type { LlmTool } from "../../../application/port/llm-provider.js";
import { hash } from "@codebase-tutor/platform";
import { maskSecrets } from "@codebase-tutor/domain";

/** MCP 客户端：把外部 MCP server 的工具接进工具循环，只做读外部这一个方向。
    默认关闭：没有配置文件就不给外部工具，工具清单与系统提示词逐字不变。
    正文不进日志：外部调用只记 `chars + hash`；返回内容进模型前先过密钥筛。 */

export interface McpServerConfig {
  /** 配置里 `mcpServers` 的键名，进工具名前缀：`mcp__<name>__<tool>`。 */
  name: string;
  /** 本地 stdio server 的启动命令。 */
  command: string;
  args?: string[];
  cwd?: string;
  /** 传给子进程的环境变量；值不回显、不落日志。 */
  env?: Record<string, string>;
  /** 工具白名单：完整 id 或裸工具名；未写 = 该 server 报上来的工具全部开放。 */
  allowedTools?: string[];
}

/** 配置里一条原始条目（`mcpServers` 的值）；`url` / `type` / `headers` 是远程 server 的写法，本引擎不接。 */
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

export interface ExternalSurface {
  /** 已带 `mcp__server__tool` 前缀、可以直接进 provider 请求的清单。 */
  tools: LlmTool[];
  /** 连不上或被跳过的 server 与原因。 */
  errors: { server: string; reason: string }[];
  /** 调一次；永不抛，失败返回给模型的文本与审计记录。 */
  call: (name: string, argumentsJson: string) => Promise<{ text: string; audit: McpCallAudit }>;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** 单次外部调用的墙钟上限，每次调用现读环境变量。 */
function timeoutMs(): number {
  return Math.max(1_000, Number(process.env.TUTOR_MCP_TIMEOUT_MS ?? 20_000) || 20_000);
}
/** 交回模型的字符上限，超出截断并留声明。 */
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
      // 名字要拼进工具名，服务商按 ASCII 校验工具名
      skipped.push({ server: name, reason: "server 名不合形（小写字母/数字/下划线/连字符，首字符不能是 - 或 _，≤40）" });
      continue;
    }
    if (name.includes("__")) {
      // server 名含 `__` 时无法从暴露名反解归属
      skipped.push({ server: name, reason: "server 名不能含连续下划线（与 `mcp__` 前缀冲突）" });
      continue;
    }
    if (raw?.disabled === true) { skipped.push({ server: name, reason: "配置里 disabled=true（没接）" }); continue; }
    if (typeof raw?.url === "string" && raw.url.trim()) { skipped.push({ server: name, reason: "远程 server（url/type）没接：外部调用的出境记账与 fail-closed 是前置（#175）" }); continue; }
    if (typeof raw?.command !== "string" || !raw.command.trim()) { skipped.push({ server: name, reason: "本地 server 缺 command" }); continue; }
    const allowed = Array.isArray(raw.allowedTools) ? raw.allowedTools : Array.isArray(raw.tools) ? raw.tools : [];
    // 未写白名单与空数组含义不同：空数组表示这台一个工具都不给
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
  /** 这台 server 报上来的全部工具；白名单每轮现裁。 */
  tools: LlmTool[];
  /** 暴露名 → server 侧的原始工具名。 */
  origin: Map<string, string>;
  /** 建这条连接时的启动配置指纹；变化就要重连。 */
  signature: string;
}

/** 连接池：按 server 名惰性连一次并缓存 promise；连不上、连接已死或启动配置变了就摘掉该项，下回合重连。 */
const pool = new Map<string, Promise<Connected | undefined>>();

function configSignature(config: McpServerConfig): string {
  return hash(JSON.stringify({ command: config.command, args: config.args ?? [], cwd: config.cwd ?? "", env: config.env ?? {} }));
}

/** 白名单的两种写法在这里归一；`undefined` = 未写白名单 = 全部放行。 */
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

/** 区分超时与调用失败两种结果。 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" | "failed" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, reason: "failed" as const })),
    new Promise<{ ok: false; reason: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), ms); })
  ]);
  clearTimeout(timer);
  return outcome;
}

/** 组装本轮的外部工具面；没有配置文件就返回 `undefined`。 */
export async function externalToolSurface(): Promise<ExternalSurface | undefined> {
  const { servers, skipped } = readMcpConfigs();
  // 配置里删掉的 server 先收尾
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
      // 启动配置变了就连新的
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
        // 调用失败时关连接并摘池，子进程由 close() 收尾
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

/** 关连接并清池。 */
export async function closeExternalTools(): Promise<void> {
  const entries = await Promise.all([...pool.values()]);
  pool.clear();
  for (const entry of entries) await entry?.client.close().catch(() => undefined);
}

/** 清空连接池并关掉子进程，供测试收尾。 */
export function resetExternalTools(): void {
  const pending = [...pool.values()];
  pool.clear();
  for (const entry of pending) void entry.then((connected) => connected?.client.close().catch(() => undefined), () => undefined);
}
