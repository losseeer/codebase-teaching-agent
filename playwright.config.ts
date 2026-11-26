import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

/** e2e 用独立的数据目录与不可达的模型端点：不碰 ~/.codebase-tutor，也不发真实请求。 */
const dataDir = join(tmpdir(), "codebase-tutor-e2e");
mkdirSync(dataDir, { recursive: true });
const isolatedEnv = {
  TUTOR_REGISTRY_FILE: join(dataDir, "repositories.json"),
  TUTOR_LLM_SETTINGS_FILE: join(dataDir, "llm-settings.json"),
  TUTOR_LLM_PROFILES_FILE: join(dataDir, "llm-profiles.json"),
  TUTOR_LEARNER_DB: join(dataDir, "learner.db"),
  TUTOR_MCP_SETTINGS_FILE: join(dataDir, "mcp.json"),
  TUTOR_PROFILE_META_FILE: join(dataDir, "profile-meta.json"),
  TUTOR_PROFILE_FILE: join(dataDir, "profile.md"),
  TUTOR_SKILLS_DIR: join(dataDir, "skills"),
  TUTOR_ENGINE_LOG: "off",
  TUTOR_LLM_PROVIDER: "openai-compatible",
  TUTOR_LLM_MODEL: "e2e-fixture",
  TUTOR_OPENAI_URL: "http://127.0.0.1:9/v1",
  OPENAI_API_KEY: "e2e-key"
};

// 3100/3101 是 e2e 专用端口；被中断后残留的 server 也带着同一套隔离 env，复用是安全的
const enginePort = 3101;
const guiPort = 3100;

export default defineConfig({
    testDir: "./e2e",
    // 默认包含真实模型与沙箱的用例（e2e 的价值就在真实链路）；E2E_FAST=1 时排除，做快速 UI 回归
    ...(process.env.E2E_FAST ? { testIgnore: ["**/zz-live.spec.ts"] } : {}),
    timeout: 60_000,
    // 共用一个引擎与一份地址簿：串行跑，避免互相污染
    workers: 1,
    fullyParallel: false,
    use: { baseURL: `http://127.0.0.1:${guiPort}` },
    // 独立专用端口：用户自己的 dev server 在 3000/3001，这里不会碰到；复用残留的 e2e server 不会丢隔离 env
    webServer: [
      {
        command: "pnpm --filter @codebase-tutor/engine dev",
        url: `http://127.0.0.1:${enginePort}/api/health`,
        reuseExistingServer: true,
        timeout: 120_000,
        env: { ...(process.env as Record<string, string>), ...isolatedEnv, ENGINE_PORT: String(enginePort) }
      },
      {
        command: `pnpm --filter @codebase-tutor/gui dev --port ${guiPort}`,
        url: `http://127.0.0.1:${guiPort}`,
        reuseExistingServer: true,
        timeout: 120_000,
        env: { ...(process.env as Record<string, string>), VITE_ENGINE_ORIGIN: `http://127.0.0.1:${enginePort}` }
      }
    ]
});
