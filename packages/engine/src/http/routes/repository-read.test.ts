import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RepositoryAnalysis } from "@codebase-tutor/shared";
import { createRouteFixture, MAIN_FILE, type RouteFixture } from "./route-test-kit.js";
import { TutorDatabase } from "../../store/database.js";

/**
  只读产物那组路由的边界：`GET /source` 只放**已索引**的文件（索引白名单替它挡住了密钥载体），
  越界与软链接各判一次；`GET /analysis` 顺带交出的语言画像是读侧现算的元数据，不进任何产物。
  单测查不出「带着真挂载态时到底给不给」，所以这组打路由。
 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("GET /analysis 附带的语言画像", () => {
  it("响应带本仓语言分布与能力档，但落库产物一字未改（不进缓存键）", async () => {
    const callsBefore = fx.fetchCalls();
    const response = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/analysis` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as RepositoryAnalysis & { languageProfile?: NonNullable<RepositoryAnalysis["languageProfile"]> };

    const row = body.languageProfile?.languages.find((item) => item.language === "typescript");
    expect(row, "只有一个 .ts 文件的仓，语言分布应当只有 TypeScript 一行").toBeDefined();
    expect(row!.files).toBe(1);
    expect(row!.inDependencyGraph).toBe(true);
    // 档直接从共享表来：界面不许自己判语言
    expect(row!.capabilities.cells.dependencyEdge).toBe("exact");
    // 旧产物的图没有 parseBackend → 按 regex 认，符号抽取那个字段不能因此被说成语法树结果
    expect(body.languageProfile!.parseBackend).toBe("regex");

    // 关键一条：响应里多了字段，库里那份 analysis 不能有——它是缓存键的输入，写回去就等于给全仓重烧开票
    const database = new TutorDatabase(fx.repoDir);
    const stored = database.getAnalysis(fx.repositoryId);
    database.close();
    expect(stored, "落库产物读不出来就没法比对").toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(stored!, "languageProfile")).toBe(false);
    expect(stored!.versionStamp).toBe("content:fixture");
    // 零 token：拿语言画像不该付出任何模型调用
    expect(fx.fetchCalls()).toBe(callsBefore);
  });
});

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
    路由这一侧也做**链接目标实测**（`pathReadBlock`，与 `read_file` 同一份判据）。
    以前只有工具侧查，HTTP 侧停在「字面路径在不在仓里 + 在不在索引里」：仓里放一个名字无害的链接
    就能只绕过界面那道闸。
    ⚠️ 链接取名 `evidence.txt` 是算过的两难：`.png` 会先被**名字**那道闸拦下（「该文件类型不开放读取」），
    根本走不到链接判定；而 `.ts`/`.md` 这类**收录**扩展名一进仓就是真改动，会排一轮重分析换掉挂载中的产物
    （#163 守的正是这件事）。`.txt` 既不在拒读名单、也不在收录集，才只验链接这一关。
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