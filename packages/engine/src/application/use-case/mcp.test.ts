import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readMcpConfigUseCase, saveMcpConfigUseCase } from "./mcp.js";

let dir = "";
const original = process.env.TUTOR_MCP_SETTINGS_FILE;

describe("MCP 配置保存", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mcp-config-")); process.env.TUTOR_MCP_SETTINGS_FILE = join(dir, "mcp.json"); });
  afterEach(() => {
    if (original === undefined) delete process.env.TUTOR_MCP_SETTINGS_FILE;
    else process.env.TUTOR_MCP_SETTINGS_FILE = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it("拒绝非 JSON、缺 mcpServers、远程 server 与缺 command", () => {
    expect(saveMcpConfigUseCase("不是 JSON").ok).toBe(false);
    expect(saveMcpConfigUseCase('{"foo":{}}').ok).toBe(false);
    expect(saveMcpConfigUseCase('{"mcpServers":{"a":{"url":"https://x"}}}').ok).toBe(false);
    expect(saveMcpConfigUseCase('{"mcpServers":{"a":{}}}').ok).toBe(false);
  });

  it("合法配置落盘后可读回；disabled 不要求 command", () => {
    const text = JSON.stringify({ mcpServers: { demo: { command: "node", args: ["server.js"], env: { TOKEN: "x" } }, off: { disabled: true } } }, null, 2);
    const saved = saveMcpConfigUseCase(text);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.servers.map((item) => item.name)).toEqual(["demo"]);
    expect(saved.value.servers[0].envKeys).toEqual(["TOKEN"]);
    expect(readMcpConfigUseCase().text).toContain("\"demo\"");
  });
});
