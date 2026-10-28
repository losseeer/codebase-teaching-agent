import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteFixture, MAIN_FILE, type RouteFixture } from "../controller-test-kit.js";

/** GET /source 的边界：只放行已索引文件，越界与仓外软链接各判一次。 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("GET /source 的取文件边界", () => {
  // 往 repoDir 写文件不触发重分析
  it("索引里的文件照给；越界 400，未收录（含 .env）404", async () => {
    writeFileSync(join(fx.repoDir, ".env"), "OPENAI_API_KEY=sk-never-serve-me\n", "utf8");

    const served = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/source?path=${encodeURIComponent(MAIN_FILE)}&line=3` });
    expect(served.statusCode).toBe(200);
    const body = served.json() as { path: string; line: number; content: string };
    expect(body.path).toBe(MAIN_FILE);
    expect(body.line).toBe(3);
    expect(body.content).toContain("// line 1");

    const escaped = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/source?path=${encodeURIComponent("../outside.env")}` });
    expect(escaped.statusCode).toBe(400);

    for (const path of [".env", "src/../.env", `${MAIN_FILE}.bak`]) {
      const refused = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/source?path=${encodeURIComponent(path)}` });
      expect(refused.statusCode, `${path} 不该被这条路由读出来`).toBe(404);
      expect(refused.payload).not.toContain("sk-never-serve-me");
    }
  });

  it("line 不是数字时按 1 回，不把 NaN 序列化成的 null 发给界面", async () => {
    const response = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/source?path=${encodeURIComponent(MAIN_FILE)}&line=abc` });
    expect((response.json() as { line: number }).line).toBe(1);
  });

  /** 仓外软链接在索引检查之前判定。 */
  it("仓里的符号链接指向仓外时，这条路由也给不出原文", async () => {
    const sentinel = "OUTSIDE-SENTINEL-must-not-be-served";
    writeFileSync(join(fx.root, "outside-target.txt"), `${sentinel}\n`, "utf8");
    symlinkSync(join(fx.root, "outside-target.txt"), join(fx.repoDir, "evidence.txt"));

    const response = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/source?path=${encodeURIComponent("evidence.txt")}` });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error?: string }).error).toContain("符号链接指向仓库之外");
    expect(response.payload).not.toContain(sentinel);
    rmSync(join(fx.repoDir, "evidence.txt"), { force: true });
  });
});
