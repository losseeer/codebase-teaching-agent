import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repositoryId as deriveRepositoryId } from "../../identity.js";
import { createRouteFixture, type RouteFixture } from "./route-test-kit.js";
import { appendMessages, createThread, softDeleteThread } from "../../store/chat-store.js";

/**
  会话线程：线程 id 由引擎发，正文落在各自仓的 chat_message 里；仓被移出地址簿之后，线程仍可只凭 threadId 定位（读侧不靠内存挂载）。
 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("未挂载仓库的线程仍可定位", () => {
  it("GET/PATCH/DELETE 三条线程路由不该把被驱逐的会话判成已删除", async () => {
    const registryFile = process.env.TUTOR_REGISTRY_FILE;
    expect(registryFile, "地址簿要指向临时文件").toBeTruthy();
    const original = readFileSync(registryFile!, "utf8");

    // 第二个仓：只建目录并写它自己的库——它不进挂载路径（这几条路由只需要库路径，产物在不在都一样读）
    const archivedDir = join(fx.root, "archived");
    mkdirSync(archivedDir, { recursive: true });
    const archivedId = deriveRepositoryId(archivedDir);
    writeFileSync(registryFile!, `${JSON.stringify({ repositories: [fx.repoDir, archivedDir] }, null, 2)}\n`, "utf8");
    const thread = createThread({ repositoryPath: archivedDir, repositoryId: archivedId, scope: "map", title: "旧对话" });
    expect(appendMessages(archivedDir, thread.id, [{ role: "user", content: "上次问到哪了？" }])).toBe(true);

    try {
      // 前提要钉住：它确实没挂在内存里，否则测的还是老那条路
      const catalog = await fx.app.inject({ method: "GET", url: "/api/repositories" });
      const entry = (catalog.json() as { repositories: { repositoryPath: string; mounted: boolean }[] }).repositories
        .find((item) => item.repositoryPath === archivedDir);
      expect(entry?.mounted, "这条用例要跑在「仓未挂载」的前提下").toBe(false);

      const messages = await fx.app.inject({ method: "GET", url: `/api/threads/${thread.id}/messages` });
      expect(messages.statusCode, "被驱逐不等于已删除").toBe(200);
      expect((messages.json() as { messages: { content: string }[] }).messages[0]?.content).toBe("上次问到哪了？");

      expect((await fx.app.inject({ method: "PATCH", url: `/api/threads/${thread.id}`, payload: { title: "改了名" } })).statusCode).toBe(200);
      expect((await fx.app.inject({ method: "DELETE", url: `/api/threads/${thread.id}` })).statusCode).toBe(200);
      // 删掉之后才该是 404：软删的线程读侧恒带 `deleted_at IS NULL`
      expect((await fx.app.inject({ method: "GET", url: `/api/threads/${thread.id}/messages` })).statusCode).toBe(404);
    } finally {
      writeFileSync(registryFile!, original, "utf8");
      rmSync(archivedDir, { recursive: true, force: true });
    }
  });
});

/** 会话下拉的取数口径：只列谈过的会话，但当前打开着的那条空壳要被认下来。 */
describe("线程清单的收录口径", () => {
  it("零消息的会话不进列表；?current 认下正打开的那条，删掉或不属于这个作用域才回 null", async () => {
    const unsent = createThread({ repositoryPath: fx.repoDir, repositoryId: fx.repositoryId, scope: "map", title: "刚点新建" });
    const talked = createThread({ repositoryPath: fx.repoDir, repositoryId: fx.repositoryId, scope: "map", title: "谈过的" });
    expect(appendMessages(fx.repoDir, talked.id, [{ role: "user", content: "谈过一句" }])).toBe(true);

    const plain = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/threads?scope=map` });
    expect((plain.json() as { threads: { title: string }[] }).threads.map((thread) => thread.title)).toEqual(["谈过的"]);
    expect(plain.json()).toMatchObject({ current: null });

    const asked = await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/threads?scope=map&current=${unsent.id}` });
    expect((asked.json() as { current?: { id?: string } }).current?.id, "空壳不在清单里，但界面正开着它——剪枝判据要用这一格").toBe(unsent.id);

    const elsewhere = createThread({ repositoryPath: fx.repoDir, repositoryId: fx.repositoryId, scope: "teach", title: "教学的" });
    expect((await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/threads?scope=map&current=${elsewhere.id}` })).json()).toMatchObject({ current: null });

    expect(softDeleteThread(fx.repoDir, unsent.id)).toBe(true);
    expect((await fx.app.inject({ method: "GET", url: `/api/repositories/${fx.repositoryId}/threads?scope=map&current=${unsent.id}` })).json()).toMatchObject({ current: null });
  });
});
