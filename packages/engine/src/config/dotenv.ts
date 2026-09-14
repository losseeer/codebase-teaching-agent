import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      // 未加引号的值：去掉行内 # 注释（# 前须有空格，避免误伤 URL 里的 #fragment）
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
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

/** 从模块位置逐级向上找 .env（src/config/、dist/ 深度都可能变），找不到再从 cwd 向上找。 */
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
