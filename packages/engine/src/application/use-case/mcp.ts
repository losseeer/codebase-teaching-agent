/** MCP 服务配置：读写 ~/.codebase-tutor/mcp.json，保存前做结构校验并重置外部工具缓存。 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { mcpConfig } from "../../infrastructure/composition-root.js";

export interface McpConfigView {
  path: string;
  text: string;
  servers: Array<{ name: string; command: string; args?: string[]; cwd?: string; allowedTools?: string[]; envKeys: string[] }>;
  skipped: { server: string; reason: string }[];
}

export function readMcpConfigUseCase(): McpConfigView {
  const path = mcpConfig.mcpConfigFile();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // 还没建过配置：返回空文本，界面从模板写起
  }
  const { servers, skipped } = mcpConfig.readMcpConfigs(path);
  return {
    path,
    text,
    servers: servers.map(({ env, ...rest }) => ({ ...rest, envKeys: Object.keys(env ?? {}) })),
    skipped
  };
}

export type McpSaveResult = { ok: true; value: McpConfigView } | { ok: false; error: string };

export function saveMcpConfigUseCase(text: string): McpSaveResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "不是合法 JSON。" };
  }
  const map = (parsed as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { ok: false, error: "顶层要有 mcpServers 对象：一个 server 一段，别写成数组。" };
  }
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    const entry = raw as { command?: unknown; disabled?: unknown; url?: unknown } | undefined;
    if (entry?.disabled === true) continue;
    if (typeof entry?.url === "string" && entry.url.trim()) {
      return { ok: false, error: `「${name}」是远程 server：本引擎只接本地 command。` };
    }
    if (typeof entry?.command !== "string" || !entry.command.trim()) {
      return { ok: false, error: `「${name}」缺 command。` };
    }
  }
  const path = mcpConfig.mcpConfigFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  // 配置变了要让外部工具清单重连，否则下次请求还拿旧连接
  mcpConfig.resetExternalTools();
  return { ok: true, value: readMcpConfigUseCase() };
}
