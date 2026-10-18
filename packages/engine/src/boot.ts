import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance as _perf } from "node:perf_hooks";
import { traceEngine } from "./trace/engine-log.js";

/**
  开机计时的起点与分段口。单独一份是为了让**装配层**（`services.ts`）也能记分段：
  以前所有 `tboot` 都写在 `server.ts` 里，那等于要求「谁被构造」和「HTTP 怎么摆」留在同一个文件，
  而这两件事没有共同的理由长在一起。起点仍是进程解析完 imports 的那一刻。
  */
const T0 = _perf.now();

/** 启动耗时分段计时：始终落引擎日志（kind: boot），控制台回显由 TUTOR_BOOT_TIMING=1 控制。 */
export function tboot(label: string): void {
  const durationMs = Math.round(_perf.now() - T0);
  if (process.env.TUTOR_BOOT_TIMING === "1") console.log(`[boot] +${String(durationMs).padStart(5)}ms ${label}`);
  traceEngine("boot", { phase: label }, { traceId: null, durationMs });
}

/** engine version: 单源 = packages/engine/package.json. 读不到时回落到 0.0.0。 */
export const engineVersion: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();
