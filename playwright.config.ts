import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

/** e2e 用独立的数据目录与不可达的模型端点：不碰 ~/.codebase-tutor，也不发真实请求。 */
const dataDir = join(tmpdir(), "codebase-tutor-e2e");
mkdirSync(dataDir, { recursive: true });
// 只清会话库：里面的旧会话会让下一轮用例读到旧档位。配置类文件要保留，否则 capture 没有基准配置
for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dataDir, `learner.db${suffix}`), { force: true });

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

export default defineConfig({
  testDir: "./e2e",
  // 默认包含真实模型与沙箱的用例（e2e 的价值就在真实链路）；E2E_FAST=1 时排除，做快速 UI 回归
  ...(process.env.E2E_FAST ? { testIgnore: ["**/zz-live.spec.ts"] } : {}),
  timeout: 60_000,
  // 共用一个引擎与一份地址簿：串行跑，避免互相污染
  workers: 1,
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:3100" },
  // 独立端口 + 不复用：复用用户自己起的 dev server 会让上面的隔离 env 全部失效，写穿 ~/.codebase-tutor
  webServer: [
    {
      command: "pnpm --filter @codebase-tutor/engine dev",
      url: "http://127.0.0.1:3101/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...(process.env as Record<string, string>), ...isolatedEnv, ENGINE_PORT: "3101" }
    },
    {
      command: "pnpm --filter @codebase-tutor/gui dev --port 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...(process.env as Record<string, string>), VITE_ENGINE_ORIGIN: "http://127.0.0.1:3101" }
    }
  ]
});
