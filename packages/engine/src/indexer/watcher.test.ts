import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTutorIgnoreMatcher } from "./ignore.js";
import { changeWanted, isArtifactEcho, RepositoryWatcher } from "./watcher.js";

/**
  监听这一层的三条口径（2026-10-06 复审 #123）：
  ① 起不来要如实交出死活（旧写法一个空 catch，之后界面永远报 fresh）；
  ② 自己写的产物不能叫醒自己（`.tutor/**` 恒定不回声，哪怕用户把 `.tutorignore` 写成 `!.tutor/**`）；
  ③ FSWatcher 必须有 error 监听——它是 EventEmitter，运行中报错而没人听会把整台引擎带走。

  ⚠️ 测试口径：判据（`changeWanted`）用纯函数确定性测，真 fs 事件只留一条端到端兜底、
  并且把等待窗口放到 10 秒——整包并行跑时几十路 `fs.watch` 同时投递，3 秒等不到一个 change 是实测到的（第一次就因此红了）。
  时序不能当判据的依据：烧钱级的规则必须每次都能被稳定测到。
  */

const temporaryDirectories: string[] = [];

function repository(extraIgnoreLines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "tutor-watcher-"));
  temporaryDirectories.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  // 只有测试要「用户自己写过一份」时才落那个文件：写了空文件就等于替引擎把缺省播种顶掉了
  // （缺省那一份带 node_modules/ 与 .tutor/，正是第二条用例要读的东西）
  if (extraIgnoreLines.length) writeFileSync(join(dir, ".tutorignore"), `${extraIgnoreLines.join("\n")}\n`, "utf8");
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

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};

describe("RepositoryWatcher 的取舍判据（确定性）", () => {
  it("用户显式放行 `.tutor/**` 时：索引层收它，监听层照样不回声", () => {
    const dir = repository(["!.tutor/**"]);
    const matcher = createTutorIgnoreMatcher(dir);
    // 这一条是索引层的既有设计（ignore.test.ts 钉着），说明「放行」确实生效了
    expect(matcher.ignores(".tutor/tutor.db"), "前提：用户放行后匹配器认为产物该被索引").toBe(false);
    // 但监听层不跟：自激循环的代价是整仓反复重扫，更糟时反复重烧钱
    expect(changeWanted(".tutor/tutor.db", matcher)).toBe(false);
    expect(changeWanted(".tutor/journal.jsonl", matcher)).toBe(false);
    expect(changeWanted(".tutor", matcher)).toBe(false);
    expect(isArtifactEcho(".tutorx/a.ts"), "只挡这一层目录，别顺手挡掉同前缀的源码目录").toBe(false);
    expect(changeWanted("src/keep.ts", matcher)).toBe(true);
  });

  it("缺省配置下：忽略项不上报，`.tutorignore` 自己除外（改了要立刻重读）", () => {
    const dir = repository();
    const matcher = createTutorIgnoreMatcher(dir);
    expect(changeWanted("node_modules/x/index.ts", matcher)).toBe(false);
    expect(changeWanted(".tutorignore", matcher)).toBe(true);
    expect(changeWanted("src/keep.ts", matcher)).toBe(true);
  });
});

describe("RepositoryWatcher 的死活（复审 #123①③）", () => {
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

  it("运行中途的 error 事件被接住：标 dead、报出原因，而不是把引擎掀掉", () => {
    const dir = repository();
    const errors: string[] = [];
    const watcher = new RepositoryWatcher(dir, () => undefined, 50, (message) => errors.push(message));
    expect(watcher.start().started).toBe(true);
    // 直接对内部 FSWatcher 发一个 error：修复前的形状里没有监听器，这一条会变成未捕获异常
    const inner = (watcher as unknown as { watcher?: { emit(event: string, error: Error): boolean } }).watcher;
    expect(inner, "监听没起来就别继续测了").toBeTruthy();
    inner!.emit("error", new Error("inotify 额度用尽"));
    expect(errors).toEqual(["inotify 额度用尽"]);
    expect(watcher.watchStatus).toMatchObject({ started: true, dead: true, error: "inotify 额度用尽" });
    watcher.close();
  });

  it("端到端兜底：真源码改动能走到回调，且同一批里不会混进产物路径", async () => {
    const dir = repository(["!.tutor/**"]);
    const batches: string[][] = [];
    const watcher = new RepositoryWatcher(dir, (paths) => batches.push(paths), 60);
    expect(watcher.start().started).toBe(true);
    // 先写产物、再写源码：两者若都会上报就同处一批，所以「这批里没有 .tutor」是可判定的
    mkdirSync(join(dir, ".tutor"), { recursive: true });
    writeFileSync(join(dir, ".tutor", "tutor.db"), "{}", "utf8");
    writeFileSync(join(dir, "src/keep.ts"), "export const keep = 2;\n", "utf8");
    const arrived = await waitFor(() => batches.flat().includes("src/keep.ts"));
    watcher.close();
    expect(arrived, "十秒内没收到真事件：这台机器的 fs.watch 不可用，端到端这条测不了").toBe(true);
    expect(batches.flat().filter((path) => isArtifactEcho(path))).toEqual([]);
  });
});
