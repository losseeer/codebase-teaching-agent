import { spawnSync } from "node:child_process";

/** 探测本机能否真起一次 Seatbelt：同步跑一个 `/usr/bin/true`，结果缓存。 */
let cached: { usable: boolean; detail: string } | undefined;

export function nestedSandboxUsable(): { usable: boolean; detail: string } {
  if (cached) return cached;
  /** `TUTOR_TEST_FORCE_UNSUPPORTED=1` 时直接按不可用返回。 */
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
