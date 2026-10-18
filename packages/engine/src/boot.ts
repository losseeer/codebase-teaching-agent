import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance as _perf } from "node:perf_hooks";
import { traceEngine } from "./trace/engine-log.js";

/**
  开机这三件事共用一份文件，因为它们**只在进程起来的那一刻做一次**，而且都没有领域含义：
  读 `.env`、取版本号、记启动分段。以前 `.env` 单独住 `src/config/`，一个目录里只躺一个模块，
  而它的调用点只有两处（`server.ts` 与那批离线脚本）——目录名给的「配置系统」印象比它实际做的事大。

  计时起点与分段口这一对单独成文是为了让**装配层**（`services.ts`）也能记分段：
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
/**
  .env 加载（启动时读文件方案）：引擎自己解析仓库根的 .env，
  语义与 dotenv 一致——只填 process.env 里**不存在**的键，不覆盖已有环境变量。
  这样 shell 里显式 export 的值仍然优先（CI / 测试可随时压制文件值）。

  不引依赖：解析规则覆盖常规写法——`#` 注释、`export KEY=VALUE` 前缀、
  单/双引号包裹、`=` 后空格、行尾 `#` 注释（仅对未加引号的值生效）。
  */

export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === `"` || quote === `'`) && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === `"`) value = value.replace(/\\n/g, "\n").replace(/\\"/g, `"`).replace(/\\\\/g, "\\");
    } else {
      /**
        未加引号的值：`#` 起头 = 空值加说明（模板里 `KEY=   # 说明` 很常见，不特判会把整段注释当成配置值）；
        截 ` #` 时那个空格要留着，否则 URL 的 `#fragment` 会被剪掉。
      */
      if (value.startsWith("#")) value = "";
      else {
        const hash = value.indexOf(" #");
        if (hash >= 0) value = value.slice(0, hash).trim();
      }
    }
    result[key] = value;
  }
  return result;
}

/** 把 parsed 里 process.env 尚未定义的键填进去；返回实际注入的键名列表（调试/测试用）。 */
export function applyDotEnv(parsed: Record<string, string>): string[] {
  const injected: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      injected.push(key);
    }
  }
  return injected;
}

/** 从模块位置逐级向上找 .env（src/、dist/ 深度都可能变），找不到再从 cwd 向上找。 */
export function findDotEnvPath(): string | undefined {
  const walkUp = (start: string): string | undefined => {
    let dir = start;
    for (;;) {
      const candidate = join(dir, ".env");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  };
  return walkUp(dirname(fileURLToPath(import.meta.url))) ?? walkUp(process.cwd());
}

/** 启动时调用一次：加载仓库根 .env（存在即加载，静默——配置文件缺失是常态而非错误）。 */
export function loadDotEnv(): void {
  const path = findDotEnvPath();
  if (!path) return;
  try {
    applyDotEnv(parseDotEnv(readFileSync(path, "utf8")));
  } catch {
    // 读失败不阻断启动：环境变量口径仍可用，.env 缺失/损坏按未配置处理
  }
}
