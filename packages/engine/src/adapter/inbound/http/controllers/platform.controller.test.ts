import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { UI_JOURNAL_EVENTS } from "@codebase-tutor/domain";

import { createRouteFixture, MAIN_FILE, type RouteFixture } from "../controller-test-kit.js";
import { isolationBackend } from "../../../outbound/sandbox/profile.js";
import { TutorDatabase } from "../../../outbound/persistence/database.js";

/** 引擎运维面路由用例：/journal 入参守卫、来源闸、监听开关、沙箱重探、非收录文件写入。 */
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
    // 重分析会把 versionStamp 换成真实内容哈希
    expect(analysis!.versionStamp, `非收录文件的写入不该触发重分析；这轮被 ${JSON.stringify(analysis!.lastIncrementalUpdate?.changedPaths ?? null)} 叫醒`).toBe("content:fixture");
    expect(analysis!.graph.symbols.map((symbol) => symbol.path), "符号表不该被换成真实扫描的空结果").toContain(MAIN_FILE);
  });
});

/** 来源闸：非可信来源在 handler 之前被拒；放宽只经 `TUTOR_ALLOWED_ORIGINS`。 */

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
    // 健康读数含服务商、模型名与沙箱状态
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
      // 端口是来源的一部分：精确匹配不是前缀匹配
      expect((await fx.app.inject({ method: "GET", url: "/api/repositories", headers: { origin: "https://tutor.corp.dev" } })).statusCode).toBe(403);
      expect((await fx.app.inject({ method: "GET", url: "/api/repositories", headers: { origin: `${EVIL}.evil.example` } })).statusCode).toBe(403);
    } finally {
      delete process.env.TUTOR_ALLOWED_ORIGINS;
    }
    expect((await fromEvil("GET", "/api/repositories")).statusCode, "清单一撤就恢复默认关").toBe(403);
  });
});

/** 挂起监听与沙箱重探两条路由。 */

describe("编辑期免打扰与沙箱重探", () => {
  afterEach(() => {
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

  /** 沙箱读数：形状固定，等级随环境变。 */
  it("POST /api/sandbox/reprobe 返回重新探测的读数，字段形状与开机那份一致", async () => {
    const response = await fx.app.inject({ method: "POST", url: "/api/sandbox/reprobe" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { sandbox: { level: string; checks: { name: string; passed: boolean }[]; reason: string; probedAt: string } };
    expect(["enforced", "unavailable"]).toContain(body.sandbox.level);
    expect(body.sandbox.reason.length, "界面直接显示这句白话原因，不能空").toBeGreaterThan(0);
    if (isolationBackend().available) {
      expect(body.sandbox.checks.length, "有后端的机器上一次重探必须给出逐项 canary，而不是一个总判断").toBeGreaterThan(3);
    } else {
      expect(body.sandbox.checks, "零 canary 才是这台机器的实话").toEqual([]);
      expect(body.sandbox.level).toBe("unavailable");
    }
    expect(body.sandbox.checks.every((check) => typeof check.passed === "boolean")).toBe(true);
    expect(new Date(body.sandbox.probedAt).getTime()).toBeGreaterThanOrEqual(Date.now() - 60_000);
    const health = (await fx.app.inject({ method: "GET", url: "/api/health" })).json() as { sandbox: { probedAt: string } };
    expect(health.sandbox.probedAt).toBe(body.sandbox.probedAt);
  }, 30_000);
});
