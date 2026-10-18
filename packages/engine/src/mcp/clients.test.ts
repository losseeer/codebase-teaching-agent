import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeExternalTools, externalToolSurface, mcpConfigFile, readMcpConfigs, resetExternalTools } from "./clients.js";

/**
  MCP 客户端这一层的回归。全部打**本机子进程夹具**（`fixtures/echo-server.mjs`，一个真 stdio server），
  不发任何模型请求：这一层要验的是「别人的程序回什么都不能把回合掀掉」，与模型无关。

  配置形状照客户端生态的通用写法：顶层 `mcpServers`，一个 server 一段（`command` / `args` / `env` / `disabled`），
  白名单 `allowedTools`——任何一份 MCP README 里的片段都能直接贴进来。
  配置文件一律写临时目录（`TUTOR_MCP_SETTINGS_FILE`），`~/.codebase-tutor/mcp.json` 一个字都不碰。
*/

const root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-mcp-")));
const FIXTURE = join(import.meta.dirname, "fixtures", "echo-server.mjs");

/** 每个用例一个新文件：连接池按 server 名缓存，同名会串到上一个用例的结果上。 */
function configure(mcpServers: Record<string, unknown>): void {
  const file = join(root, `mcp-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers }, null, 2), "utf8");
  process.env.TUTOR_MCP_SETTINGS_FILE = file;
}

const stdio = (allowedTools?: string[]) => ({ command: process.execPath, args: [FIXTURE], ...(allowedTools ? { allowedTools } : {}) });

beforeEach(() => {
  resetExternalTools();
  delete process.env.TUTOR_MCP_TIMEOUT_MS;
});

afterEach(() => {
  delete process.env.TUTOR_MCP_SETTINGS_FILE;
});

afterAll(async () => {
  await closeExternalTools();
  rmSync(root, { recursive: true, force: true });
});

describe("读配置", () => {
  it("配置文件不存在 = 一个 server 都没有，也不报错（默认关就是关）", async () => {
    process.env.TUTOR_MCP_SETTINGS_FILE = join(root, "nope.json");
    expect(readMcpConfigs().servers).toEqual([]);
    expect(await externalToolSurface()).toBeUndefined();
    delete process.env.TUTOR_MCP_SETTINGS_FILE;
    expect(mcpConfigFile()).toContain(join(".codebase-tutor", "mcp.json"));
  });

  it("mcpServers 的几种写法各走各的路，被跳过的都留下原因", () => {
    configure({
      "docs 1": stdio(),
      "中文名字": stdio(),
      "turned-off": { ...stdio(), disabled: true },
      "remote-thing": { type: "http", url: "https://example.invalid/mcp" },
      "no-command": { args: ["x"] },
      ok: stdio()
    });
    const read = readMcpConfigs();
    expect(read.servers.map((server) => server.name)).toEqual(["ok"]);
    expect(read.skipped.map((entry) => entry.server)).toEqual(["docs 1", "中文名字", "turned-off", "remote-thing", "no-command"]);
    // 名字要拼进工具名 `mcp__<name>__<tool>`，服务商按 ASCII 校验工具名：不合形就在配置层拒掉，别等模型调用时才失败
    expect(read.skipped.find((entry) => entry.server === "docs 1")?.reason).toContain("server 名不合形");
    expect(read.skipped.find((entry) => entry.server === "中文名字")?.reason).toContain("server 名不合形");
    expect(read.skipped.find((entry) => entry.server === "turned-off")?.reason).toContain("disabled=true");
    expect(read.skipped.find((entry) => entry.server === "remote-thing")?.reason).toContain("#175");
    expect(read.skipped.find((entry) => entry.server === "no-command")?.reason).toContain("缺 command");
  });

  it("顶层漏掉 mcpServers：不猜形状，直接说清要什么", () => {
    const file = join(root, "bad-shape.json");
    writeFileSync(file, JSON.stringify({ servers: [] }), "utf8");
    process.env.TUTOR_MCP_SETTINGS_FILE = file;
    expect(readMcpConfigs().skipped[0]?.reason).toContain("mcpServers");
  });
});

describe("连上与清单", () => {
  it("工具名带 mcp__<server>__ 前缀；给了 allowedTools 就只认 allowedTools", async () => {
    configure({ docs: stdio(["echo", "leaky"]) });
    const surface = await externalToolSurface();
    expect(surface?.tools.map((tool) => tool.name)).toEqual(["mcp__docs__echo", "mcp__docs__leaky"]);
    expect(surface?.tools[0].description).toContain("【外部 docs】");
    expect(surface?.errors).toEqual([]);
  });

  it("allowedTools 写完整 id 也认（Claude Code 那套 mcp__server__tool 写法）", async () => {
    configure({ docs: stdio(["mcp__docs__echo"]) });
    const surface = await externalToolSurface();
    expect(surface?.tools.map((tool) => tool.name)).toEqual(["mcp__docs__echo"]);
  });

  it("白名单一条都没匹配上：不静默给空清单，errors 里说清是白名单的问题", async () => {
    configure({ pick: stdio(["no_such_tool_here"]) });
    const surface = await externalToolSurface();
    expect(surface, "白名单全不匹配时也要带回 errors，不能回 undefined 让这句假绿").toBeDefined();
    expect(surface?.tools).toEqual([]);
    expect(surface?.errors).toEqual([{ server: "pick", reason: "连上了但它报的工具都不在白名单里" }]);
  });

  it("子进程起不来 → 一个工具都不给，原因进读数，不抛", async () => {
    configure({ "broken-boot": { command: "/nonexistent/tutor-fixture-binary" } });
    const surface = await externalToolSurface();
    expect(surface, "连不上也要带回 errors").toBeDefined();
    expect(surface?.tools).toEqual([]);
    expect(surface?.errors[0]).toMatchObject({ server: "broken-boot", reason: "连不上（子进程起不来或 initialize 失败）" });
  });
});

describe("调用外部工具", () => {
  it("正常回话进消息；审计只有字符数与指纹，没有正文", async () => {
    configure({ ok: stdio(["echo"]) });
    const surface = await externalToolSurface();
    const outcome = await surface?.call("mcp__ok__echo", JSON.stringify({ text: "你好" }));
    expect(outcome?.text).toBe("回声：你好");
    expect(outcome?.audit).toMatchObject({ ok: true, server: "ok", tool: "echo" });
    expect(outcome?.audit.argsChars).toBe(JSON.stringify({ text: "你好" }).length);
    expect(outcome?.audit.argsHash).toHaveLength(12);
    expect(JSON.stringify(outcome?.audit)).not.toContain("你好");
  });

  it("返回内容里的密钥形态在进模型前就被隐掉，且非文本段落说明没交回", async () => {
    configure({ leaky: stdio(["leaky"]) });
    const surface = await externalToolSurface();
    const outcome = await surface?.call("mcp__leaky__leaky", "{}");
    expect(outcome?.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz01");
    expect(outcome?.audit.masked).toBe(1);
    expect(outcome?.text).toContain("1 段非文本内容未交回");
  });

  it("server 自己报错：ok=false 并留下 error，回合照走", async () => {
    configure({ broken: stdio(["broken"]) });
    const surface = await externalToolSurface();
    const outcome = await surface?.call("mcp__broken__broken", "{}");
    expect(outcome?.text.startsWith("外部工具回了错误")).toBe(true);
    expect(outcome?.audit.ok).toBe(false);
    expect(outcome?.audit.error).toBe("server_reported_error");
  });

  it("超时按上限掐断（每次调用现读 TUTOR_MCP_TIMEOUT_MS），并教模型把没核实说明白", async () => {
    configure({ slow: stdio(["slow"]) });
    process.env.TUTOR_MCP_TIMEOUT_MS = "1000";
    const surface = await externalToolSurface();
    const outcome = await surface?.call("mcp__slow__slow", "{}");
    expect(outcome?.audit.error).toBe("timeout");
    expect(outcome?.text).toContain("1s 没回话");
    expect(outcome?.text).toContain("没核实");
  }, 30_000);

  it("名字不在清单里、参数不是 JSON：都回实话，都不抛", async () => {
    configure({ guard: stdio(["echo"]) });
    const surface = await externalToolSurface();
    const unknown = await surface?.call("mcp__guard__no_such", "{}");
    expect(unknown?.audit.error).toBe("unknown_tool");
    const bad = await surface?.call("mcp__guard__echo", "{ 不是 JSON");
    expect(bad?.audit.error).toBe("bad_arguments");
    expect(bad?.text).toContain("没执行");
  });
});
