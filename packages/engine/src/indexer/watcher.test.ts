import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryWatcher } from "./watcher.js";

/**
  监听这一层的三条口径（2026-10-06 复审 #123）：
  ① 起不来要如实交出死活（旧写法一个空 catch，之后界面永远报 fresh）；
  ② 自己写的产物不能叫醒自己（`.tutor/**` 恒定不回声，哪怕用户把 `.tutorignore` 写成 `!.tutor/**`）；
  ③ FSWatcher 必须有 error 监听——它是 EventEmitter，运行中报错而没人听会把整台引擎带走。
  */

const temporaryDirectories: string[] = [];

function repository(extraIgnoreLines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "tutor-watcher-"));
  temporaryDirectories.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, ".tutorignore"), `${extraIgnoreLines.join("\n")}\n`, "utf8");
  writeFileSync(join(dir, "src/keep.ts"), "export const keep = 1;\n", "utf8");
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // 目录可能压根没建成
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return predicate();
};

describe("RepositoryWatcher", () => {
  it("路径不可监听时交出死活并出声（不再空 catch 之后一路假 fresh）", () => {
    const errors: string[] = [];
    const watcher = new RepositoryWatcher("/definitely/not/here/xyz", () => undefined, 50, (message) => errors.push(message));
    const status = watcher.start();
    expect(status.started).toBe(false);
    expect(status.dead).toBe(true);
    expect(status.error).toContain("ENOENT");
    expect(errors).toHaveLength(1);
    expect(watcher.watchStatus.dead).toBe(true);
    watcher.close();
  });

  it("自己写的产物不回声：`.tutorignore` 显式放行 `.tutor/**` 也不叫醒重分析", async () => {
    const dir = repository(["!.tutor/**"]);
    const batches: string[][] = [];
    const watcher = new RepositoryWatcher(dir, (paths) => batches.push(paths), 60);
    expect(watcher.start().started).toBe(true);
    // 先写产物、再写真源码：两个事件会同处一批，所以「这一批里没有 .tutor」是可判定的
    mkdirSync(join(dir, ".tutor"), { recursive: true });
    writeFileSync(join(dir, ".tutor", "tutor.db"), "{}", "utf8");
    writeFileSync(join(dir, ".tutor", "journal.jsonl"), "\n", "utf8");
    writeFileSync(join(dir, "src/keep.ts"), "export const keep = 2;\n", "utf8");
    const sawSourceChange = await waitFor(() => batches.flat().includes("src/keep.ts"));
    watcher.close();
    expect(sawSourceChange, "真源码改动必须被报上来，否则这条测试什么都没证明").toBe(true);
    expect(batches.flat().filter((path) => path.startsWith(".tutor/"))).toEqual([]);
  });

  it("普通源码改动照常上报，且运行中途的 error 事件被接住（不掀进程）", async () => {
    const dir = repository();
    const batches: string[][] = [];
    const errors: string[] = [];
    const watcher = new RepositoryWatcher(dir, (paths) => batches.push(paths), 60, (message) => errors.push(message));
    watcher.start();
    writeFileSync(join(dir, "src/new.ts"), "export const added = 1;\n", "utf8");
    expect(await waitFor(() => batches.flat().includes("src/new.ts"))).toBe(true);
    // 直接对内部 FSWatcher 发一个 error：修复前的形状里没有监听器，这一条会变成未捕获异常
    const inner = (watcher as unknown as { watcher?: { emit(event: string, error: Error): boolean } }).watcher;
    expect(inner, "监听没起来就别继续测了").toBeTruthy();
    inner!.emit("error", new Error("inotify 额度用尽"));
    expect(errors).toEqual(["inotify 额度用尽"]);
    expect(watcher.watchStatus).toMatchObject({ started: true, dead: true, error: "inotify 额度用尽" });
    watcher.close();
  });
});
