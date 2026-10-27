import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { UI_JOURNAL_EVENTS } from "@codebase-tutor/domain";

import { createRouteFixture, MAIN_FILE, type RouteFixture } from "../controller-test-kit.js";
import { isolationBackend } from "../../../../sandbox/profile.js";
import { TutorDatabase } from "../../../../persistence/database.js";

/**
  引擎自己的面：界面动作事件出口的形状守卫、来源闸（不可信 Origin 一行 handler 都不许跑）、
  编辑期免打扰开关、沙箱重探，以及「非收录文件的写入不该换掉挂载中的产物」。夹具与假 provider 见 `route-test-kit.ts`。
 */
const fx: RouteFixture = createRouteFixture();

beforeAll(async () => { await fx.mount(); });
afterAll(async () => { await fx.teardown(); });
beforeEach(() => { fx.reset(); });

describe("POST /journal 的入参守卫", () => {
  it("正常 UI 事件带线程 id 能落盘", async () => {
    const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/journal`, payload: { type: "file_opened", payload: { path: MAIN_FILE }, sessionId: "thread-1" } });
    expect(response.statusCode).toBe(201);
    expect(fx.lastEvent("file_opened").sessionId).toBe("thread-1");
  });

  it("sessionId 超长 / 非字符串一律 400，不落盘", async () => {
    const before = fx.eventsOf("file_opened").length;
    for (const sessionId of ["x".repeat(201), 123]) {
      const refused = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/journal`, payload: { type: "file_opened", payload: { path: MAIN_FILE }, sessionId } });
      expect(refused.statusCode, `sessionId 长度 ${String(sessionId).length} 不该被收下`).toBe(400);
    }
    expect(fx.eventsOf("file_opened").length).toBe(before);
  });

  /**
    审计线不能由被审计的一方填：这条接口本机任何进程都调得到，
    按「全部事件类型」放行就能伪造一行 `code_egress`（哪些代码出过门）或 `token_usage`（花了多少钱）。
    */
  it("引擎侧类型从这条接口写不进来：400 且区分「越权」与「未知」", async () => {
    for (const type of ["file_read", "code_egress", "token_usage", "turn_text", "turn_invariant", "session_deleted", "repository_paired"]) {
      const before = fx.eventsOf(type).length;
      const refused = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/journal`, payload: { type, payload: { path: MAIN_FILE } } });
      expect(refused.statusCode, `${type} 是引擎侧类型`).toBe(400);
      expect((refused.json() as { reason?: string }).reason, `${type} 要给出越权而非「不认识」`).toBe("engine_owned_event");
      expect(fx.eventsOf(type).length, `${type} 不该被写进审计线`).toBe(before);
    }
    const unknown = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/journal`, payload: { type: "not_a_real_event", payload: {} } });
    expect(unknown.statusCode).toBe(400);
    expect((unknown.json() as { reason?: string }).reason).toBe("unknown_event");
  });

  it("界面侧那 10 类照常能写（收紧审计线不能顺带把可观测性弄丢）", async () => {
    for (const type of UI_JOURNAL_EVENTS) {
      const response = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/journal`, payload: { type, payload: { where: "/api/x" } } });
      expect(response.statusCode, `${type} 是界面侧类型`).toBe(201);
    }
  });
});

describe("非收录文件的写入不该换掉挂载中的产物", () => {
  it("写 .env 与 credentials.json 后：等到防抖+重扫都远超，产物仍是那份 fixture", async () => {
    writeFileSync(join(fx.repoDir, ".env"), "OPENAI_API_KEY=sk-still-not-a-source-change\n", "utf8");
    writeFileSync(join(fx.repoDir, "credentials.json"), '{"aws_access_key_id":"AKIA-STILL-NOT-A-SOURCE-CHANGE"}\n', "utf8");
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const database = new TutorDatabase(fx.repoDir);
    const analysis = database.state.analysis(fx.repositoryId);
    database.close();
    expect(analysis, "产物读不出来就没法比对").toBeDefined();
    // 重分析一跑，versionStamp 就从「手工造的 content:fixture」翻成真实内容哈希，锚点同时消失
    expect(analysis!.versionStamp, `非收录文件的写入不该触发重分析；这轮被 ${JSON.stringify(analysis!.lastIncrementalUpdate?.changedPaths ?? null)} 叫醒`).toBe("content:fixture");
    expect(analysis!.graph.symbols.map((symbol) => symbol.path), "符号表不该被换成真实扫描的空结果").toContain(MAIN_FILE);
  });
});

/**
  来源闸。CORS 若反射任意来源，只听 127.0.0.1 也挡不住：浏览器里任意网页都能把请求打到这个地址，
  发请求不需要跨域权限，只有读响应才需要。它是唯一的 Web 闸，只管「哪个页面能碰这台引擎」，
  不管「本机哪个进程能碰」。

  这一组用例把三件事分开钉住：① 非可信来源被拒在执行之前（不只是不给 CORS 头）；
  ② 回环来源与不带 Origin 的本机调用方照常能用；③ 放宽只有一个口子（TUTOR_ALLOWED_ORIGINS）。
*/

describe("来源闸：默认只服务本机浏览器", () => {
  const EVIL = "http://evil.example";
  const fromEvil = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    fx.app.inject({ method, url, headers: { origin: EVIL, ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { payload } : {}) });

  it("非可信来源读不到源码，响应也不带 access-control-allow-origin", async () => {
    const refused = await fromEvil("GET", `/api/repositories/${fx.repositoryId}/source?path=${encodeURIComponent(MAIN_FILE)}`);
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { reason?: string }).reason).toBe("origin_not_trusted");
    expect(refused.headers["access-control-allow-origin"], "不给回头：浏览器连读响应的资格都没有").toBeUndefined();
    expect(refused.payload).not.toContain("// line 1");
  });

  it("非可信来源改不动出网端点：403 之外更要紧的是「没执行」", async () => {
    const before = (await fx.app.inject({ method: "GET", url: "/api/llm/settings" })).json() as { baseUrl?: string };
    const refused = await fromEvil("PUT", "/api/llm/settings", { baseUrl: "http://evil.example:9/v1" });
    expect(refused.statusCode).toBe(403);
    const after = (await fx.app.inject({ method: "GET", url: "/api/llm/settings" })).json() as { baseUrl?: string };
    expect(after.baseUrl, "闸拦的是这一次改配置，不是只挡响应可见性").toBe(before.baseUrl);
  });

  it("非可信来源触发不了导入：地址簿与挂载集合一条都没多", async () => {
    const before = (await fx.app.inject({ method: "GET", url: "/api/repositories" })).json() as { repositories: unknown[] };
    const refused = await fromEvil("POST", "/api/imports", { path: join(fx.root, "not-a-repo-from-evil") });
    expect(refused.statusCode).toBe(403);
    const after = (await fx.app.inject({ method: "GET", url: "/api/repositories" })).json() as { repositories: unknown[] };
    expect(after.repositories.length).toBe(before.repositories.length);
  });

  it("连 /api/health 也不白给：这道闸免的是「不带 Origin 的本机调用」，不是「任意网页」", async () => {
    // 健康读数里有服务商、模型名、沙箱闸门状态，不该让任意网页白拿；
    // 进程管理器与本机 curl 不带 Origin，照样走得通
    const refused = await fromEvil("GET", "/api/health");
    expect(refused.statusCode).toBe(403);
    expect(refused.payload).not.toContain("fixture-model");
    expect((await fx.app.inject({ method: "GET", url: "/api/health" })).statusCode, "本机 curl（无 Origin）照常用").toBe(200);
  });

  it("回环来源任何端口都放行——GUI 的正常形态没被这次收紧锁死", async () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:5199", "http://[::1]:3001"]) {
      const response = await fx.app.inject({ method: "GET", url: "/api/repositories", headers: { origin } });
      expect(response.statusCode, origin).toBe(200);
      expect(response.headers["access-control-allow-origin"], origin).toBe(origin);
    }
  });

  it("唯一的放宽口子是清单本身：写进 TUTOR_ALLOWED_ORIGINS 才认，且按精确来源匹配", async () => {
    process.env.TUTOR_ALLOWED_ORIGINS = `${EVIL}, https://Tutor.Corp.dev:8443/`;
    try {
      expect((await fromEvil("GET", "/api/repositories")).statusCode).toBe(200);
      expect((await fx.app.inject({ method: "GET", url: "/api/repositories", headers: { origin: "https://tutor.corp.dev:8443" } })).statusCode).toBe(200);
      // 端口是来源的一部分：清单里那条带 8443，不带端口的同一个主机名不算命中（别把精确匹配读成前缀匹配）
      expect((await fx.app.inject({ method: "GET", url: "/api/repositories", headers: { origin: "https://tutor.corp.dev" } })).statusCode).toBe(403);
      expect((await fx.app.inject({ method: "GET", url: "/api/repositories", headers: { origin: `${EVIL}.evil.example` } })).statusCode).toBe(403);
    } finally {
      delete process.env.TUTOR_ALLOWED_ORIGINS;
    }
    expect((await fromEvil("GET", "/api/repositories")).statusCode, "清单一撤就恢复默认关").toBe(403);
  });
});

/**
  两个控制口的路由级验收：挂起监听（改仓期间不要重分析）与沙箱重探（修好环境后不必重启进程）。
  两条都不花钱：前者不触发任何调用，后者打的是探测进程自己起的回环监听。
  */

describe("编辑期免打扰与沙箱重探", () => {
  afterEach(() => {
    // 挂起态不能留给后面的用例：它会让这个仓的增量监听在别的用例里静默缺席
    fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/watch`, payload: { paused: false } });
  });

  it("挂起 → 地址簿读数跟着变 → 恢复；这条路由不会顺带重分析", async () => {
    const before = (await fx.app.inject({ method: "GET", url: "/api/repositories" })).json() as { repositories: { repositoryId: string; watchPaused?: boolean }[] };
    expect(before.repositories.find((item) => item.repositoryId === fx.repositoryId)?.watchPaused, "前提：默认没有挂起").toBeUndefined();

    const paused = await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/watch`, payload: { ttlMs: 5 * 60_000 } });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as { paused: boolean; watching: boolean }).paused).toBe(true);

    const catalog = (await fx.app.inject({ method: "GET", url: "/api/repositories" })).json() as { repositories: { repositoryId: string; watchPaused?: boolean; watchPausedUntil?: string }[] };
    const entry = catalog.repositories.find((item) => item.repositoryId === fx.repositoryId);
    expect(entry?.watchPaused).toBe(true);
    expect(new Date(entry?.watchPausedUntil ?? 0).getTime()).toBeGreaterThan(Date.now());

    const resumed = (await fx.app.inject({ method: "POST", url: `/api/repositories/${fx.repositoryId}/watch`, payload: { paused: false } })).json() as { paused: boolean; woken: boolean };
    expect(resumed).toMatchObject({ paused: false, woken: true });
    const after = (await fx.app.inject({ method: "GET", url: "/api/repositories" })).json() as { repositories: { repositoryId: string; watchPaused?: boolean }[] };
    expect(after.repositories.find((item) => item.repositoryId === fx.repositoryId)?.watchPaused, "恢复后读数要跟着回来").toBeUndefined();
  });

  it("地址簿里没有的仓连挂起都谈不上：懒挂载钩子先 404，原因如实给出", async () => {
    const missing = await fx.app.inject({ method: "POST", url: "/api/repositories/repo_not_in_the_book/watch", payload: { paused: true } });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { reason?: string }).reason, "这条路由不重复实现「仓在不在」的判断，口径与其余带 :fx.repositoryId 的路由同一处").toBe("not_in_catalog");
  });

  /**
    断言与环境无关：能判的都要判准，但「判成什么」允许随环境变——能跑嵌套 `sandbox-exec` 的机器上是
    enforced，受限 CI 上是 unavailable，两者都是合法读数（环境不支持不能报成通过）。
    与环境无关的是形状：等级、白话原因、时间戳、逐项布尔。逐项 canary 只在这台机器有隔离后端时才存在，
    `isolationBackend()` 判没有时探测直接短路，那种读数是「零项 + unavailable + 一句原因」。
    超时给到 30 秒：这一发要起十来个沙箱子进程，本身 2.7~4.5 秒，全量并行时会超出默认时限。
    */
  it("POST /api/sandbox/reprobe 返回重新探测的读数，字段形状与开机那份一致", async () => {
    const response = await fx.app.inject({ method: "POST", url: "/api/sandbox/reprobe" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { sandbox: { level: string; checks: { name: string; passed: boolean }[]; reason: string; probedAt: string } };
    expect(["enforced", "unavailable"]).toContain(body.sandbox.level);
    expect(body.sandbox.reason.length, "界面直接显示这句白话原因，不能空").toBeGreaterThan(0);
    if (isolationBackend().available) {
      expect(body.sandbox.checks.length, "有后端的机器上一次重探必须给出逐项 canary，而不是一个总判断").toBeGreaterThan(3);
    } else {
      // 没有后端却报出 canary，那是编的；报了 enforced 更是要命（整域禁用的闸门被绕过）
      expect(body.sandbox.checks, "零 canary 才是这台机器的实话").toEqual([]);
      expect(body.sandbox.level).toBe("unavailable");
    }
    expect(body.sandbox.checks.every((check) => typeof check.passed === "boolean")).toBe(true);
    expect(new Date(body.sandbox.probedAt).getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);
    // 与开机那份同源：/api/health 的 sandbox 必须已经是重探之后的读数
    const health = (await fx.app.inject({ method: "GET", url: "/api/health" })).json() as { sandbox: { probedAt: string } };
    expect(health.sandbox.probedAt).toBe(body.sandbox.probedAt);
  }, 30_000);
});
