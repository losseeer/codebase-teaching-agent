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

/** 装配好的那一个 app（模块级单例）；导出给路由级测试拿同一份注册完钩子的实例。 */
export const app = await createApp();

/**
  三条收尾钩子分开挂：onClose 按注册反向执行，退出时先写完两条日志、再关 MCP 子进程、最后放掉仓库侧资源。
  日志 flush 排在最前：长连接会挂住 `close()`，排在后面的钩子可能跑不到。
*/
app.addHook("onClose", async () => { await releaseMountedRepositories(); });
app.addHook("onClose", async () => { await releaseExternalTools(); });
app.addHook("onClose", async () => { await flushAuditLines(); });

// 测试里不占端口：VITEST 置位时由测试自己按 port: 0 监听。
const port = Number(process.env.ENGINE_PORT?.trim()) || 3001;
if (!process.env.VITEST) {
  await app.listen({ port, host: "127.0.0.1" });
  tboot("listening");
  // 信号处理先装上，再打开机读数：沙箱探测要起十来个进程，那期间按下 Ctrl+C 也该能正常收尾。
  installShutdownHandler({ close: () => app.close() });
  runStartupReadings();
}
