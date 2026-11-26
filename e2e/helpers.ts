import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, type Page } from "@playwright/test";

/** 冻结的演示仓：5 个文件、20K，导入秒级，不依赖模型（端点不可达时摘要走确定性档）。 */
export const FIXTURE = join(process.cwd(), "test-fixtures", "frozen-demo-repo");

/** 导入夹具仓并进入架构全景；地址簿按路径去重，重复导入不会多出条目。 */
export async function ensureWorkspace(page: Page): Promise<void> {
  await page.goto("/import");
  await page.locator("#repo-path").fill(FIXTURE);
  await page.getByRole("button", { name: /开始导入|重新分析/ }).click();
  const enter = page.getByRole("button", { name: /进入架构全景/ });
  await expect(enter).toBeVisible({ timeout: 90_000 });
  await enter.click();
  await expect(page).toHaveURL(/workspace=map/);
}

/** 记录页面上的 console 错误与未捕获异常，用例收尾时断言为空。 */
export function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** 测试用的一张分层图：两个分组、四个节点、两条边。 */
function demoDiagramBody(): Record<string, unknown> {
  const node = (id: string, label: string, x: number, y: number, group?: string) => ({ id, kind: "module", label, x, y, ...(group ? { group } : {}), ref: `dir:${id}` });
  return {
    groups: [
      { id: "g-access", label: "接入层", x: 20, y: 20, w: 360, h: 120 },
      { id: "g-core", label: "核心层", x: 20, y: 200, w: 360, h: 120 }
    ],
    nodes: [
      node("console", "控制台", 40, 50, "g-access"),
      node("gateway", "网关", 220, 50, "g-access"),
      node("shortener", "短链服务", 40, 230, "g-core"),
      node("redirect", "跳转服务", 220, 230, "g-core")
    ],
    edges: [
      { id: "e1", from: "console", to: "gateway", origin: "static" },
      { id: "e2", from: "gateway", to: "shortener", origin: "inferred" }
    ],
    versions: []
  };
}

/** 直接把一张图写进被分析仓的 .tutor 库，供画布交互用例使用（无模型也能测拖拽）。 */
export async function seedDiagram(page: Page, name = "E2E 分层图"): Promise<void> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), "codebase-tutor.workspace");
  const workspace = raw ? JSON.parse(raw) as { repositoryId: string; repositoryPath: string } : null;
  if (!workspace) throw new Error("seedDiagram 需要先进入过工作区");
  // better-sqlite3 的 .node 按 Node ABI 分份，走引擎自己的多 ABI 加载器，别用默认 bindings
  const engineDir = join(process.cwd(), "packages/engine");
  /* eslint-disable @typescript-eslint/no-var-requires */
  const Database = require(require.resolve("better-sqlite3", { paths: [engineDir] })) as new (path: string, options?: unknown) => { prepare: (sql: string) => { run: (...args: unknown[]) => unknown }; close: () => void };
  const { loadAddon } = require(join(engineDir, "src/adapter/outbound/persistence/betterSqlite3Loader.cjs")) as { loadAddon: () => unknown };
  /* eslint-enable @typescript-eslint/no-var-requires */
  const database = new Database(join(workspace.repositoryPath, ".tutor", "tutor.db"), { nativeBinding: loadAddon(), timeout: 5000 });
  try {
    const now = Date.now();
    database.prepare("INSERT OR REPLACE INTO diagram (repository_id, diagram_id, name, source, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(workspace.repositoryId, "e2e-diagram", name, "agent", now, now, JSON.stringify(demoDiagramBody()));
  } finally {
    database.close();
  }
  await page.reload();
}

/**
  e2e 进程能否真起一次 Seatbelt。某些 agent 的执行环境不允许嵌套 sandbox-exec，
  trae 之类不会出这个问题——所以这是环境差异，代码题用例据此跳过而不是判失败。
*/
export function sandboxNestedUsable(): boolean {
  if (process.platform !== "darwin") return false;
  const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 10_000 });
  return probe.status === 0;
}

/** 从项目根 .env 读真实模型配置；CI 上没有 .env，返回 null 让 live 用例跳过。 */
export function readLiveLlm(): { provider: string; model: string; baseUrl: string; apiKey: string } | null {
  let text: string;
  try { text = readFileSync(join(process.cwd(), ".env"), "utf8"); } catch { return null; }
  const entries = new Map<string, string>();
  for (const line of text.split("\n")) {
    const matched = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (matched) entries.set(matched[1]!, matched[2]!.trim().replace(/^["']|["']$/g, ""));
  }
  const live = {
    provider: entries.get("TUTOR_LLM_PROVIDER") || "openai-compatible",
    model: entries.get("TUTOR_LLM_MODEL") || "",
    baseUrl: entries.get("TUTOR_OPENAI_URL") || "",
    apiKey: entries.get("OPENAI_API_KEY") || ""
  };
  return live.model && live.baseUrl && live.apiKey ? live : null;
}

/** 运行时切到真实模型；调用方负责用 useFakeLlm 复原，别让后续用例打到真实端点。 */
export async function useLiveLlm(page: Page): Promise<void> {
  const live = readLiveLlm();
  if (!live) throw new Error("没有真实模型凭证：live 用例应先被 skip");
  const response = await page.request.put("/api/llm/settings", { data: live });
  expect(response.ok(), `切换真实模型失败：${await response.text()}`).toBeTruthy();
}

export async function useFakeLlm(page: Page): Promise<void> {
  await page.request.put("/api/llm/settings", { data: { provider: "openai-compatible", model: "e2e-fixture", baseUrl: "http://127.0.0.1:9/v1", apiKey: "e2e-key" } });
}
