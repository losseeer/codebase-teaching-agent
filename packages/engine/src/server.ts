/**
  进程入口：读 .env、装配 HTTP、挂收尾钩子、监听。
  传输装配在 `adapter/inbound/http/create-app.ts`，运行中单例在 `infrastructure/composition-root.ts`，
  用例在 `application/`，开机读数与信号收尾在 `infrastructure/bootstrap.ts`。
*/
import { createApp } from "./adapter/inbound/http/create-app.js";
import { loadDotEnv, tboot } from "./boot.js";
import { flushAuditLines, installShutdownHandler, releaseExternalTools, releaseMountedRepositories, runStartupReadings } from "./infrastructure/bootstrap.js";

// .env 先加载：buildLlmRuntimeProvider 在运行期读取 TUTOR_LLM_* 配置
loadDotEnv();
tboot("imports resolved");

/** 模块级单例 app；路由级测试复用同一实例。 */
export const app = await createApp();

// onClose 按注册反向执行：先 flush 日志，再关 MCP 子进程，最后释放仓库句柄
app.addHook("onClose", async () => { await releaseMountedRepositories(); });
app.addHook("onClose", async () => { await releaseExternalTools(); });
app.addHook("onClose", async () => { await flushAuditLines(); });

// VITEST 置位时不监听端口，由测试自己按 port: 0 启动
const port = Number(process.env.ENGINE_PORT?.trim()) || 3001;
if (!process.env.VITEST) {
  await app.listen({ port, host: "127.0.0.1" });
  tboot("listening");
  // 信号处理先装上，再跑开机读数
  installShutdownHandler({ close: () => app.close() });
  runStartupReadings();
}
