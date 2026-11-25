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
  TUTOR_ENGINE_LOG: "off",
  TUTOR_LLM_PROVIDER: "openai-compatible",
  TUTOR_LLM_MODEL: "e2e-fixture",
  TUTOR_OPENAI_URL: "http://127.0.0.1:9/v1",
  OPENAI_API_KEY: "e2e-key"
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // 共用一个引擎与一份地址簿：串行跑，避免互相污染
  workers: 1,
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:3000" },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...(process.env as Record<string, string>), ...isolatedEnv }
  }
});
