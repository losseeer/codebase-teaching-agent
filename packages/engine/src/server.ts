/**
  进程入口：读 .env、装配 HTTP、挂上三条收尾钩子、监听，然后才谈开机读数。
  正文都不在这里——传输装配在 `adapter/inbound/http/create-app.ts`，运行中单例在 `infrastructure/composition-root.ts`，
  用例在 `application/`，开机读数与信号收尾在 `infrastructure/bootstrap.ts`（那一层不碰 fastify，这里递一个 `close` 回调过去）。
*/
import { createApp } from "./adapter/inbound/http/create-app.js";
import { loadDotEnv, tboot } from "./boot.js";
import { flushAuditLines, installShutdownHandler, releaseExternalTools, releaseMountedRepositories, runStartupReadings } from "./infrastructure/bootstrap.js";

// .env 先加载：`buildLlmRuntimeProvider` 在运行期随时可能被调用，它要能在设置缺项时读到 TUTOR_LLM_* 那套回落值
loadDotEnv();
tboot("imports resolved");

/**
  装配好的那一个 app（模块级单例，产品路径与测试路径共用）。
  导出是给路由级测试的：`controller-test-kit.ts` 与 `events-stream.test.ts` 都靠 `await import("../../../server.js")`
  拿到「钩子与路由都注册完」的同一份实例——自己 new 一份会漏掉来源闸与懒挂载，测出来的就不是产品那条路径。
  它们必须在 import 之前把 fetch 桩好（provider 在构造时就把 fetch 绑成实例字段），所以这一步不能提前。
  */
export const app = await createApp();

/**
  三条收尾钩子分开挂，不合并：fastify 的 onClose 按注册的**反向**执行，所以退出时先是写完两条日志，
  再关引擎起的 MCP 子进程，最后放掉仓库侧资源（监听与挂载句柄）。
  日志 flush 排在最前是有理由的——`/api/events` 这类长连接会挂住 `close()`，1.5s 一到就直接 exit，
  排在后面的钩子可能根本没机会跑；顺序一变，丢的就是最贵的收尾对账行。
  */
app.addHook("onClose", async () => { await releaseMountedRepositories(); });
app.addHook("onClose", async () => { await releaseExternalTools(); });
app.addHook("onClose", async () => { await flushAuditLines(); });

// 测试里不占端口：vitest 会把 VITEST 置为 "true"，此时路由级测试仍然 import 本文件拿 app，但自己按需要用 port: 0 监听
// （`events-stream.test.ts` 就是这么做的）。不加这道闸，测试会和 pnpm dev 正在跑的引擎抢 3001 端口，直接 EADDRINUSE 崩在 import。
const port = Number(process.env.ENGINE_PORT?.trim()) || 3001;
if (!process.env.VITEST) {
  await app.listen({ port, host: "127.0.0.1" });
  tboot("listening");
  // 信号处理先装上，再打开机读数：沙箱探测要起十来个进程，那期间按下 Ctrl+C 也该能正常收尾。
  installShutdownHandler({ close: () => app.close() });
  runStartupReadings();
}
