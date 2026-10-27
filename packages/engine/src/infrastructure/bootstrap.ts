/**
  进程的生命周期：挂载侧资源什么时候释放、开机要把哪些读数当场说出来、收到信号后怎么收尾。
  这一层刻意不碰 fastify——收尾只要一个「把服务关掉」的回调，谁提供它由入口文件 `server.ts` 决定；
  「只有入站适配器与进程入口能碰 fastify」这条守卫就是这么写的（见 `architecture.test.ts`）。
*/
import { flushEngineLog, traceEngine } from "@codebase-tutor/platform";

import { closeExternalTools } from "../adapter/outbound/integrations/clients.js";
import { installBundledSkills } from "../adapter/outbound/integrations/skills.js";
import { flushLlmLog } from "../adapter/outbound/llm/call-log.js";
import { reprobeIsolation } from "../adapter/outbound/sandbox/isolation.js";
import { budgetGateNotice } from "../cost/cost.js";
import { importer } from "./composition-root.js";

/**
  仓库侧资源（外部 MCP 子进程与两条日志各有自己的一条收尾钩子，顺序由入口文件的注册次序决定，这里不合并）：
  `app.close()` 不会替我们关 `fs.FSWatcher`——它是活跃 handle，不移除就是「HTTP 已关、监听还替引擎抱着一个目录」。
  挂载句柄的 `close()` 自己按引用计数放行，正在被请求握着的连接不会被打断。
  */
export async function releaseMountedRepositories(): Promise<void> {
  for (const repository of importer.mountedRepositories()) {
    repository.watcher?.close();
    repository.handle.close();
  }
}

/**
  把已排队的两条日志写完。`appendLine` 走异步队列，直接 exit 会把收尾那几行留在内存里丢掉——
  engine.jsonl 丢的是 mount 的 schemaGaps 与 degrade 行，llm.log 丢的正是「这一发到底花没花钱」的对账凭据。
  */
export async function flushAuditLines(): Promise<void> {
  await Promise.all([flushEngineLog(), flushLlmLog()]);
}

/**
  开机就把该看见的读数说出来：访问控制口径、沙箱闸门、出厂技能、预算闸门。
  最后两条都是 fail-closed 的形状——闸门失效不能等到用户点下按钮才知道，所以当场打印并按 `degrade` 落账。
  */
export function runStartupReadings(): void {
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

/**
  信号收尾：先跑 `close()`（入口文件挂在 onClose 上的那几条钩子），收尾完按 0 退出——
  否则子进程与 SQLite 句柄留在机器上，Ctrl+C 也以 130 退出被 pnpm 报成失败。
  收尾带 1.5s 上限：`/api/events` 这类长连接会一直挂着 `close()`，不能让它拖住退出。
  */
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
      // 先把已排队的日志写完：长连接会挂住 `close()`，1.5s 一到就直接 exit，排在 onClose 里的那次 flush 可能根本没机会跑。
      // llm.log 也是异步队列，漏掉的正是最贵的收尾对账行。
      void flushAuditLines();
      options.close().then(() => { clearTimeout(guard); done(); }, (error: unknown) => { clearTimeout(guard); console.error(`[engine] 收尾没跑完（外部 MCP 子进程或日志 flush 抛错）：${String(error)}`); done(); });
    });
  }
}

/** 外部 MCP 子进程是引擎起来的，不能留在机器上——入口文件把它挂成第二条 onClose 钩子。 */
export async function releaseExternalTools(): Promise<void> {
  await closeExternalTools();
}
