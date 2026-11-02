import { describe, expect, it, vi } from "vitest";

import { pickLocalDirectory, type CommandRunner } from "./folder-picker.js";

/** 目录选择只验命令编排与取消/失败判定；不真的打开系统窗口。 */

const commandError = (code: string | number, stderr = ""): Error => Object.assign(new Error("command failed"), { code, stderr });

describe("本机目录选择", () => {
  it("macOS：取 POSIX 路径并去掉结尾斜杠", async () => {
    const run = vi.fn<CommandRunner>(async () => ({ stdout: "/Users/me/repo/\n", stderr: "" }));
    const result = await pickLocalDirectory({ platform: "darwin", run });
    expect(result).toEqual({ ok: true, path: "/Users/me/repo" });
    expect(run).toHaveBeenCalledWith("/usr/bin/osascript", ["-e", expect.stringContaining("choose folder")]);
  });

  it("macOS：用户取消按 canceled 回，不报错", async () => {
    const run = vi.fn<CommandRunner>(async () => { throw commandError(1, "execution error: User canceled. (-128)"); });
    expect(await pickLocalDirectory({ platform: "darwin", run })).toEqual({ ok: false, reason: "canceled" });
  });

  it("macOS：系统窗口执行失败与取消分开", async () => {
    const run = vi.fn<CommandRunner>(async () => { throw commandError(1, "execution error: Not authorized to send Apple events. (-1743)"); });
    expect(await pickLocalDirectory({ platform: "darwin", run })).toEqual({ ok: false, reason: "failed", message: "目录选择窗口打不开，可以手动输入路径。" });
  });

  it("Linux：zenity 可用就用它", async () => {
    const run = vi.fn<CommandRunner>(async () => ({ stdout: "/home/me/repo\n", stderr: "" }));
    expect(await pickLocalDirectory({ platform: "linux", run })).toEqual({ ok: true, path: "/home/me/repo" });
    expect(run).toHaveBeenCalledWith("zenity", expect.arrayContaining(["--directory"]));
  });

  it("Linux：zenity 不在时退到 kdialog", async () => {
    const run = vi.fn<CommandRunner>(async (command) => {
      if (command === "zenity") throw commandError("ENOENT");
      return { stdout: "/home/me/kde-repo\n", stderr: "" };
    });
    expect(await pickLocalDirectory({ platform: "linux", run })).toEqual({ ok: true, path: "/home/me/kde-repo" });
    expect(run.mock.calls.map(([command]) => command)).toEqual(["zenity", "kdialog"]);
  });

  it("Linux：两种窗口都没有就明说不可用", async () => {
    const run = vi.fn<CommandRunner>(async () => { throw commandError("ENOENT"); });
    expect(await pickLocalDirectory({ platform: "linux", run })).toEqual({ ok: false, reason: "unavailable", message: "这台机器没有可用的目录选择窗口，请手动输入路径。" });
  });

  it("Windows：保留盘符路径；空输出当取消", async () => {
    const picked = vi.fn<CommandRunner>(async () => ({ stdout: "C:\\code\\repo", stderr: "" }));
    expect(await pickLocalDirectory({ platform: "win32", run: picked })).toEqual({ ok: true, path: "C:\\code\\repo" });

    const canceled = vi.fn<CommandRunner>(async () => ({ stdout: "", stderr: "" }));
    expect(await pickLocalDirectory({ platform: "win32", run: canceled })).toEqual({ ok: false, reason: "canceled" });
  });

  it("不认识的平台不猜命令，直接回不可用", async () => {
    const run = vi.fn<CommandRunner>();
    expect(await pickLocalDirectory({ platform: "freebsd" as NodeJS.Platform, run })).toEqual({ ok: false, reason: "unavailable", message: "这台机器没有可用的目录选择窗口，请手动输入路径。" });
    expect(run).not.toHaveBeenCalled();
  });

  it("同一时刻只开一个窗口：第二次调用等同一份结果", async () => {
    let finish: (value: { stdout: string; stderr: string }) => void = () => undefined;
    const run = vi.fn<CommandRunner>(() => new Promise((resolve) => { finish = resolve; }));
    const first = pickLocalDirectory({ platform: "darwin", run });
    const second = pickLocalDirectory({ platform: "darwin", run });
    expect(second).toBe(first);
    finish({ stdout: "/Users/me/repo\n", stderr: "" });
    await expect(first).resolves.toEqual({ ok: true, path: "/Users/me/repo" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
