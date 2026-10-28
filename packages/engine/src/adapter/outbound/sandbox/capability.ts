import { spawnSync } from "node:child_process";

/**
  探测本机能否真起一次 Seatbelt：同步跑一个 `/usr/bin/true`，结果缓存。判据是真跑，不看可执行文件是否存在。
  集成用例按结果分档：能用则照跑，不能用则自我跳过并说明环境不支持。
*/
let cached: { usable: boolean; detail: string } | undefined;

export function nestedSandboxUsable(): { usable: boolean; detail: string } {
  if (cached) return cached;
  /** 测试与受限 CI 用的显式挡板：置 1 时按「起不了沙箱」处理。 */
  if (process.env.TUTOR_TEST_FORCE_UNSUPPORTED === "1") {
    cached = { usable: false, detail: "测试注入：按「本机起不了嵌套 sandbox-exec」处理" };
    return cached;
  }
  if (process.platform !== "darwin") {
    cached = { usable: false, detail: `非 darwin（${process.platform}），没有隔离后端实现` };
    return cached;
  }
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 10_000 });
  const detail = `${result.error?.message ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
  cached = result.status === 0 ? { usable: true, detail } : { usable: false, detail: detail || `exit=${String(result.status)} sig=${String(result.signal ?? "-")}` };
  return cached;
}
