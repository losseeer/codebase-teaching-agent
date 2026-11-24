import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveToolchain, seatbeltProfile } from "./profile.js";

/** 探测本机能否真起一次 Seatbelt：用真实执行的 profile 跑一次 node，结果缓存。 */
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
  // 用真实执行的 profile 探测：全放行的 profile 能过、严格 profile 却起不来，会让集成用例忽跑忽跳
  const toolchain = resolveToolchain();
  if (!toolchain.node) {
    cached = { usable: false, detail: "PATH 里找不到 node，无法探测沙箱" };
    return cached;
  }
  const workdir = mkdtempSync(join(tmpdir(), "codebase-tutor-probe-"));
  let result;
  try {
    result = spawnSync("/usr/bin/sandbox-exec", ["-p", seatbeltProfile(workdir, toolchain), toolchain.node, "-e", "0"], { encoding: "utf8", timeout: 10_000 });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  const detail = `${result.error?.message ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
  cached = result.status === 0 ? { usable: true, detail } : { usable: false, detail: detail || `exit=${String(result.status)} sig=${String(result.signal ?? "-")}` };
  return cached;
}
