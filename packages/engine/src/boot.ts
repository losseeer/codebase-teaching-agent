import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance as _perf } from "node:perf_hooks";
import { traceEngine } from "@codebase-tutor/platform";

/**
  开机原语：读 `.env`、取版本号、记启动分段。
  `T0` 与 `tboot` 同处一文，装配层才能也记分段。
  */
const T0 = _perf.now();

/** 启动耗时分段计时：始终落引擎日志（kind: boot），控制台回显由 TUTOR_BOOT_TIMING=1 控制。 */
export function tboot(label: string): void {
  const durationMs = Math.round(_perf.now() - T0);
  if (process.env.TUTOR_BOOT_TIMING === "1") console.log(`[boot] +${String(durationMs).padStart(5)}ms ${label}`);
  traceEngine("boot", { phase: label }, { traceId: null, durationMs });
}

/** engine 版本号单源 = packages/engine/package.json；读不到回落 0.0.0。 */
export const engineVersion: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version as string;
  } catch (error) {
    // 版本只用于 /api/health 回显；读不到要留一行原因。
    console.warn(`[boot] 读不到 engine 的 package.json version，健康检查将回显 0.0.0：${String(error)}`);
    return "0.0.0";
  }
})();
/**
  .env 解析：只填 process.env 里不存在的键，shell 显式 export 的优先。
  支持 `#` 注释、`export` 前缀、单双引号、行尾注释。
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
      /** 未加引号的值：`#` 起头按空值；行尾注释只认 ` #`，否则会剪掉 URL 的 `#fragment`。 */
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

/** 启动时调用一次：加载本项目根的 .env；文件不存在时静默。 */
export function loadDotEnv(): void {
  const path = findDotEnvPath();
  if (!path) return;
  try {
    applyDotEnv(parseDotEnv(readFileSync(path, "utf8")));
  } catch (error) {
    // 读得到却解析不动时必须出声：否则所有配置按未配置生效。
    console.warn(`[boot] .env 读到了却用不上，按未配置处理：path=${path} error=${String(error)}`);
  }
}
