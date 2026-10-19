import { spawnSync } from "node:child_process";

/**
  「这台机器能不能真的起一次 Seatbelt」——同步、只跑一个 `/usr/bin/true`，给测试当分档用。
  容器与受限 CI 里嵌套 `sandbox-exec` 会被拒（`sandbox_apply: Operation not permitted`），
  真跑用例全红但那不是产品缺陷；反过来无条件跳过，支持沙箱的机器上也拿不到隔离证据。所以分档：
  - 能用 ⇒ 集成用例照跑照红（红就是缺陷）；
  - 不能用 ⇒ 集成用例自我跳过并在输出里点名「环境不支持 ≠ 通过」，
    产品侧的 fail-closed 由不依赖沙箱的那几条钉住（探测没过时 `runSandbox` 必须抛，见 sandbox.test.ts）。

  判据用一次真跑，不看 `sandbox-exec` 在不在：文件在却起不来（嵌套被禁、策略拦）正是要区分的情况。
*/
let cached: { usable: boolean; detail: string } | undefined;

export function nestedSandboxUsable(): { usable: boolean; detail: string } {
  if (cached) return cached;
  /**
    只给测试与受限 CI 用的显式挡板：`TUTOR_TEST_FORCE_UNSUPPORTED=1` 直接按「起不了沙箱」处理。
    它买不到假通过：走这条时集成用例自我跳过，而「探测没过 ⇒ 整域拒」那几条照跑。
  */
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
