import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteFixture, MAIN_FILE, type RouteFixture } from "./route-test-kit.js";

/**
  只读产物那组路由的边界：`GET /source` 只放已索引的文件（索引白名单挡住密钥载体），
  越界与软链接各判一次。挂载态下的取舍在单测里看不出来，所以这组打到路由。
 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

/** llm.log 落点：每次 provider 调用都要有一行；线程归属必须跟着进来（前缀缓存按线程算间隔靠它）。 */

describe("GET /source 的取文件边界", () => {
  // ⚠️ 本文件后面的用例靠 beforeAll 手工造的产物（锚点在 src/main.ts:3）跑。往 fx.repoDir 写文件这件事本身
  // 不该惊动重分析（收录判据见 indexer 的 isIngestedPath，#163 那条用例钉着），但挪动用例顺序前先想清楚这一条。
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

  /**
    路由这一侧也判链接目标（`pathReadBlock`，与 `read_file` 同一份判据），否则仓里放一个名字无害的
    链接就只绕过了界面这道闸。夹具取名 `evidence.txt` 是有讲究的：`.png` 先被扩展名名单拦下、
    走不到链接判定；`.ts` / `.md` 属收录扩展名，写进仓就会排一轮重分析换掉挂载中的产物；
    `.txt` 既不在拒读名单也不在收录集，只剩链接这一关可验。
    */
  it("仓里的符号链接指向仓外时，这条路由也给不出原文", async () => {
    const sentinel = "OUTSIDE-SENTINEL-must-not-be-served";
    writeFileSync(join(fx.root, "outside-target.txt"), `${sentinel}\n`, "utf8");
    symlinkSync(join(fx.root, "outside-target.txt"), join(fx.repoDir, "evidence.txt"));

    const response = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/source?path=${encodeURIComponent("evidence.txt")}` });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error?: string }).error).toContain("符号链接指向仓库之外");
    expect(response.payload).not.toContain(sentinel);
    rmSync(join(fx.repoDir, "evidence.txt"), { force: true }); // 只摘链接，仓外那份真目标不动
  });
});

/** UI 动作事件出口：契约里写的「sessionId 有长度上限」得有实现钉住（超长会永久占进 append-only 的审计线）。 */