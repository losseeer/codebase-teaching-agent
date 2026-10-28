/**
  进程生命周期：挂载侧资源的释放时机、开机读数、信号收尾。
  这一层不碰 fastify：收尾只要一个关闭回调，由 `server.ts` 提供。
*/
import { flushEngineLog, traceEngine } from "@codebase-tutor/platform";

import { closeExternalTools } from "../adapter/outbound/integrations/clients.js";
import { installBundledSkills } from "../adapter/outbound/integrations/skills.js";
import { flushLlmLog } from "../adapter/outbound/llm/call-log.js";
import { reprobeIsolation } from "../adapter/outbound/sandbox/isolation.js";
import { budgetGateNotice } from "../cost/cost.js";
import { importer } from "./composition-root.js";

/** 释放挂载仓库的监听与句柄；`app.close()` 不会替我们关 `fs.FSWatcher`。 */
export async function releaseMountedRepositories(): Promise<void> {
  for (const repository of importer.mountedRepositories()) {
    repository.watcher?.close();
    repository.handle.close();
  }
}

/** 把已排队的两条日志写完：`appendLine` 走异步队列，直接 exit 会丢收尾行。 */
export async function flushAuditLines(): Promise<void> {
  await Promise.all([flushEngineLog(), flushLlmLog()]);
}

/** 开机打印该看见的读数：访问控制口径、沙箱闸门、出厂技能、预算闸门。 */
export function runStartupReadings(): void {
  console.log("[engine] 访问控制：无认证闸（本机任意进程都能调）｜来源闸生效（只信回环与 TUTOR_ALLOWED_ORIGINS，非可信来源 403）");
  /** 沙箱隔离探测放后台跑，结果开机就报；不过则代码题整域禁用。 */
  void reprobeIsolation().then((sandbox) => {
    console.log(`[engine] 沙箱：${sandbox.level === "enforced" ? `强制隔离已验（${sandbox.checks.length} 项 canary 全过 · ${sandbox.backend} · ${sandbox.durationMs}ms）` : `未通过——代码题域禁用：${sandbox.reason}`}`);
    if (sandbox.level !== "enforced") {
      traceEngine("degrade", { what: "sandbox_isolation", reason: sandbox.reason }, { traceId: null });
    }
  });
  // 出厂预置技能：复制到 `TUTOR_SKILLS_DIR` 第一处；同名不覆盖。
  try {
    const seeded = installBundledSkills();
    if (seeded.installed.length || seeded.skipped.length) {
      console.log(`[engine] 出厂技能：装了 ${seeded.installed.length} 份到 ${seeded.target}${seeded.kept.length ? `｜${seeded.kept.length} 份同名已存在，保留你那份` : ""}${seeded.skipped.length ? `｜${seeded.skipped.length} 份形状不合没搬：${seeded.skipped.map((entry) => `${entry.dir}：${entry.reason}`).join("、")}` : ""}`);
    }
  } catch (error) {
    // 装不上只影响预置技能，不影响开机。
    console.warn(`[engine] 出厂技能没装：${error instanceof Error ? error.message : String(error)}`);
  }
  // 单价全没配就是预算闸门失效：开机就要看得见。
  const gateNotice = budgetGateNotice();
  if (gateNotice) {
    console.warn(`[engine] ${gateNotice}`);
    traceEngine("degrade", { what: "budget_gate", reason: "pricing_unset" }, { traceId: null });
  }
}

/** 信号收尾：先跑 `close()` 再按 0 退出；收尾带 1.5s 上限，长连接不能拖住退出。 */
export function installShutdownHandler(options: { close(): Promise<void> }): void {
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
      // 收尾超时直接 exit 时，先把已排队的日志写完。
      void flushAuditLines();
      options.close().then(() => { clearTimeout(guard); done(); }, (error: unknown) => { clearTimeout(guard); console.error(`[engine] 收尾没跑完（外部 MCP 子进程或日志 flush 抛错）：${String(error)}`); done(); });
    });
  }
}

/** 释放引擎启动的外部 MCP 子进程。 */
export async function releaseExternalTools(): Promise<void> {
  await closeExternalTools();
}
