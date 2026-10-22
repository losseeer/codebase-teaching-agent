/**
  HTTP 装配与开机：Fastify 实例、CORS、三道请求钩子（trace / 来源闸 / 懒挂载）、路由注册、优雅关停。
  正文都不在这里——路由在 `http/routes/`，单例在 `services.ts`，用例在 `application/`。
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { tboot } from "./boot.js";
import { importer } from "./services.js";
import { broadcast } from "./events.js";
import { budgetGateNotice } from "./cost/cost.js";
import { id } from "./identity.js";
import { loadDotEnv } from "./boot.js";
import { isTrustedOrigin } from "./security/origins.js";
import { reprobeIsolation } from "./sandbox/isolation.js";
import { runWithTrace } from "./trace/context.js";
import { flushEngineLog, traceEngine } from "./trace/engine-log.js";
import { flushLlmLog } from "./llm/call-log.js";
import { closeExternalTools } from "./external/clients.js";
import { installBundledSkills } from "./external/skills.js";
import { registerPlatformRoutes } from "./http/routes/platform.js";
import { registerSettingsRoutes } from "./http/routes/settings.js";
import { registerRepositoryReadRoutes } from "./http/routes/repository-read.js";
import { registerDiagramRoutes } from "./http/routes/diagrams.js";
import { registerExerciseRoutes } from "./http/routes/exercises.js";
import { registerChatRoutes } from "./http/routes/chat.js";
import { registerTeachingRoutes } from "./http/routes/teaching.js";
import { registerThreadRoutes } from "./http/routes/threads.js";

// .env 先加载：`buildLlmRuntimeProvider` 在运行期随时可能被调用，它要能在设置缺项时读到 TUTOR_LLM_* 那套回落值
loadDotEnv();
tboot("imports resolved");

/** 导出只为给路由级测试用 `app.inject()`（见 server-routes.test.ts）；产品路径仍然是本文件自己 listen。 */
export const app = Fastify({
  // traceId 即 reqId：pino 的请求行、本进程记的 trace 事件、llm.log 与 journal 共享同一个 id
  genReqId: () => id(),
  logger: { level: process.env.LOG_LEVEL ?? "warn" }
});
// CORS 必须先于来源闸注册：钩子按注册顺序跑，被拦的响应（403）也要带 access-control-allow-origin，
// 否则浏览器里只剩一句「网络错误」，用户读不到引擎给的中文原因。
// 来源不反射任意值：只有可信来源才给 `access-control-allow-origin`（判据一处：`security/origins.ts`）。
await app.register(cors, { origin: (origin, callback) => callback(null, Boolean(origin && isTrustedOrigin(origin))) });
tboot("cors registered");
// 请求级 trace 上下文：`run(id, done)` 让后续钩子与 handler 继承该 store（传播原理见 trace/context.ts）
app.addHook("onRequest", (request, _reply, done) => { runWithTrace(request.id, done); });

/**
  来源闸：不可信的 `Origin` 当场 403，handler 一行都不执行。
  光靠 CORS 不给回头只挡住「浏览器读到响应」，服务端副作用照样发生；这一道把它挪到执行之前。
  预检交给 CORS 插件——非可信来源拿不到回头的预检响应，实际请求到不了这儿。
  ⚠️ 不豁免 `/api/health`：健康读数里有服务商、模型名与沙箱闸门状态，不给任意网页白拿。
  这一道只管「浏览器里哪个页面能碰这台引擎」，本机进程不在它的管辖范围内（没有认证闸）。
  */
app.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (!origin || request.method === "OPTIONS" || isTrustedOrigin(origin)) return;
  return reply.code(403).send({ error: `来源「${origin}」不在可信清单里：引擎默认只服务本机浏览器（回环来源）。跨来源部署请把该来源写进 TUTOR_ALLOWED_ORIGINS。`, reason: "origin_not_trusted" });
});

app.addHook("onResponse", (request, reply, done) => {
  traceEngine("http", { method: request.method, url: request.url, status: reply.statusCode }, { traceId: request.id, durationMs: Math.round(reply.elapsedTime) });
  done();
});
tboot("Fastify constructed");

/**
  关停钩子（仓库侧资源；外部 MCP 子进程在文件末尾另有自己的一条）：
  LRU 驱逐与 `forget` 各关自己那条监听，但 `app.close()` 不会——`fs.FSWatcher` 是活跃 handle，
  不移除就是「HTTP 已关、监听还替引擎抱着一个目录」。挂载句柄的 `close()` 自己按引用计数放行。
  */
app.addHook("onClose", async () => {
  for (const repository of importer.mountedRepositories()) {
    repository.watcher?.close();
    repository.handle.close();
  }
});

/**
  懒挂载钩子：`/api/repositories/:repositoryId/*` 的每个请求先确保该仓已挂进内存。
  boot 零 IO、零 watcher，地址簿里不活跃的仓完全不占资源，代价只是首次访问某个仓的请求稍慢。
  挂载失败按原因回 404 + `reason`，GUI 据此分清「工作区确实失效（清掉）」与「目录挪走/产物不全（留着处置）」。
  任何一支都不触发重新分析——重跑是花钱动作，只由用户点头。
  唯一豁免是移出地址簿那条 DELETE：它要处理的恰恰是挂不起来的仓，钩子先拦它用户就被锁在自己的地址簿外面。
  */
app.addHook("preHandler", async (request, reply) => {
  const repositoryId = (request.params as { repositoryId?: unknown })?.repositoryId;
  if (typeof repositoryId !== "string" || !repositoryId) return;
  if (request.method === "DELETE" && request.routeOptions?.url === "/api/repositories/:repositoryId") return;
  const result = importer.ensureMounted(repositoryId);
  if (result.ok) return;
  return reply.code(404).send({ error: result.message, reason: result.reason });
});

// 事件桥：仓库侧的挂载/导入/失效事件要能广播到 GUI 的 `/api/events`（订阅表在 events.ts）
importer.on("event", broadcast);

/**
  路由按面分组住在 `http/routes/`，这里只做注册（顺序不影响匹配——各组路径互不重叠）。
  分组判据之一是会不会花钱：`repository-read` 一组一行模型请求都不发，付费的几组把闸门口径写在各自文件头。
  */
registerPlatformRoutes(app);
registerSettingsRoutes(app);
registerRepositoryReadRoutes(app);
registerDiagramRoutes(app);
registerExerciseRoutes(app);
registerChatRoutes(app);
registerTeachingRoutes(app);
registerThreadRoutes(app);

// 退出时关掉外部 MCP 子进程：它们是引擎起来的，不能留在机器上。
app.addHook("onClose", async () => { await closeExternalTools(); });
// 最后一条：把已排队的两条日志写完再退。`appendLine` 走异步队列，直接 exit 会把收尾那几行留在内存里丢掉——
// engine.jsonl 丢的是 mount 的 schemaGaps 与 degrade 行，llm.log 丢的正是「这一发到底花没花钱」的对账凭据。
app.addHook("onClose", async () => { await Promise.all([flushEngineLog(), flushLlmLog()]); });

// 测试里不占端口：vitest 会把 VITEST 置为 "true"，此时只用 app.inject() 打路由。
// 不加这道闸，测试会和 pnpm dev 正在跑的引擎抢 3001 端口直接 EADDRINUSE 崩在 import。
const port = Number(process.env.ENGINE_PORT ?? 3001);
if (!process.env.VITEST) {
  await app.listen({ port, host: "127.0.0.1" });
  tboot("listening");
  /**
    收到 SIGINT/SIGTERM 时先跑 `app.close()`（onClose 钩子：关 fs 监听、关挂载句柄、关引擎起的外部 MCP 子进程），
    收尾完按 0 退出——否则子进程与 SQLite 句柄留在机器上，Ctrl+C 也以 130 退出被 pnpm 报成失败。
    收尾带 1.5s 上限：`/api/events` 这类长连接会一直挂着 `server.close()`，不能让它拖住退出。
    */
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        console.log(`[engine] 又收到一次 ${signal}，直接退出（收尾已经在跑）`);
        process.exit(0);
      }
      shuttingDown = true;
      console.log(`[engine] 收到 ${signal}，开始收尾（监听 / 库句柄 / 外部 MCP 子进程）`);
      const done = (): void => process.exit(0);
      const guard = setTimeout(done, 1_500);
      // 先把已排队的日志写完：`/api/events` 这类长连接会挂住 `app.close()`，1.5s 一到就直接 exit，
      // 排在 onClose 钩子里的那次 flush 可能根本没机会跑。llm.log 也是异步队列，漏掉的正是最贵的收尾对账行。
      void flushEngineLog();
      void flushLlmLog();
      app.close().then(() => { clearTimeout(guard); done(); }, (error: unknown) => { clearTimeout(guard); console.error(`[engine] 收尾没跑完（外部 MCP 子进程或日志 flush 抛错）：${String(error)}`); done(); });
    });
  }
  console.log("[engine] 访问控制：无认证闸（本机任意进程都能调）｜来源闸生效（只信回环与 TUTOR_ALLOWED_ORIGINS，非可信来源 403）");
  /**
    沙箱隔离探测：逐项 canary 要起十来个进程，放后台跑（不拖监听），但结果必须开机就看得见。
    没过的话代码题域整域禁用，不降级成「弱隔离照跑」——闸门失效不能等到用户点下按钮才知道（fail-closed）。
    */
  void reprobeIsolation().then((sandbox) => {
    console.log(`[engine] 沙箱：${sandbox.level === "enforced" ? `强制隔离已验（${sandbox.checks.length} 项 canary 全过 · ${sandbox.backend} · ${sandbox.durationMs}ms）` : `未通过——代码题域禁用：${sandbox.reason}`}`);
    if (sandbox.level !== "enforced") {
      traceEngine("degrade", { what: "sandbox_isolation", reason: sandbox.reason }, { traceId: null });
    }
  });
  // 出厂预置技能：复制到 `TUTOR_SKILLS_DIR` 第一处（缺省 `~/.codebase-tutor/skills`）。同名不覆盖、坏形状不搬。
  try {
    const seeded = installBundledSkills();
    if (seeded.installed.length || seeded.skipped.length) {
      console.log(`[engine] 出厂技能：装了 ${seeded.installed.length} 份到 ${seeded.target}${seeded.kept.length ? `｜${seeded.kept.length} 份同名已存在，保留你那份` : ""}${seeded.skipped.length ? `｜${seeded.skipped.length} 份形状不合没搬：${seeded.skipped.map((entry) => `${entry.dir}：${entry.reason}`).join("、")}` : ""}`);
    }
  } catch (error) {
    // 装不上只是没有预置技能，不该掀掉开机（家目录只读、磁盘满都在这一条里）
    console.warn(`[engine] 出厂技能没装：${error instanceof Error ? error.message : String(error)}`);
  }
  // 单价全没配 = 预算闸门失效（有闸门名没有闸门）：与沙箱闸门同纪律，必须开机就在账面上看得见（fail-closed）。
  const gateNotice = budgetGateNotice();
  if (gateNotice) {
    console.warn(`[engine] ${gateNotice}`);
    traceEngine("degrade", { what: "budget_gate", reason: "pricing_unset" }, { traceId: null });
  }
}
