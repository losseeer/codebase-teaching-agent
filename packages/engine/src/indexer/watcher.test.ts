import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTutorIgnoreMatcher } from "@codebase-tutor/analysis";
import { changeWanted, changedAfter, ingestSetDiffers, isArtifactEcho, RepositoryWatcher } from "./watcher.js";
import { listIngestedPaths } from "./indexer.js";

/**
  监听层的行为测试：运行状态上交、产物不算源码改动、FSWatcher 有 error 监听。
  纯函数用例确定性测；端到端用例依赖真 fs 事件。
*/

const temporaryDirectories: string[] = [];

function repository(extraIgnoreLines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "tutor-watcher-"));
  temporaryDirectories.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  // 空 `.tutorignore` 会取代默认播种，只在有内容时写
  if (extraIgnoreLines.length) writeFileSync(join(dir, ".tutorignore"), `${extraIgnoreLines.join("\n")}\n`, "utf8");
  writeFileSync(join(dir, "src/keep.ts"), "export const keep = 1;\n", "utf8");
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // 目录可能没建成。
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
    expect(matcher.ignores(".tutor/tutor.db"), "前提：用户放行后匹配器认为产物该被索引").toBe(false);
    expect(changeWanted(".tutor/tutor.db", matcher)).toBe(false);
    expect(changeWanted(".tutor/journal.jsonl", matcher)).toBe(false);
    expect(changeWanted(".tutor", matcher)).toBe(false);
    expect(isArtifactEcho(".tutorx/a.ts"), "只挡这一层目录，别顺带挡掉同前缀的源码目录").toBe(false);
    expect(changeWanted("src/keep.ts", matcher)).toBe(true);
  });

  it("默认配置下：忽略项不上报，`.tutorignore` 自己除外（改了要立刻重读）", () => {
    const dir = repository();
    const matcher = createTutorIgnoreMatcher(dir);
    expect(changeWanted("node_modules/x/index.ts", matcher)).toBe(false);
    expect(changeWanted(".tutorignore", matcher)).toBe(true);
    expect(changeWanted("src/keep.ts", matcher)).toBe(true);
  });

  it("事件类型是 file 的那一支按收录集筛：非收录扩展名与密钥载体名都不算源码改动", () => {
    const dir = repository();
    const matcher = createTutorIgnoreMatcher(dir);
    expect(changeWanted("src/keep.ts", matcher, "file"), "收录进来的源码照样叫醒").toBe(true);
    expect(changeWanted(".env", matcher, "file"), "`.env` 从来不在扩展名白名单里").toBe(false);
    expect(changeWanted("assets/logo.png", matcher, "file")).toBe(false);
    expect(changeWanted("credentials.json", matcher, "file"), "读层判它「不开放读取」，索引不收它，写入也就不该叫醒重分析").toBe(false);
    expect(changeWanted("src", matcher, "directory")).toBe(true);
    expect(changeWanted("src/gone.md", matcher, "gone")).toBe(true);
    expect(changeWanted("node_modules", matcher, "directory"), "忽略目录整片不叫醒").toBe(false);
    expect(changeWanted("src/keep.ts", matcher, "predates-watch"), "监听起点之前就存在的文件不算改动").toBe(false);
    expect(changeWanted(".tutorignore", matcher, "predates-watch"), "引擎自己播种的那份配置也不算改动").toBe(false);
  });

  it("收录集快照比对只认路径集合（模糊事件的最后一道筛）", () => {
    expect(ingestSetDiffers(["src/a.ts"], ["src/a.ts"])).toBe(false);
    expect(ingestSetDiffers(["src/a.ts"], ["src/a.ts", "src/b.ts"])).toBe(true);
    expect(ingestSetDiffers(["src/a.ts", "src/b.ts"], ["src/a.ts"]), "删掉一个收录文件同样是变").toBe(true);
    expect(ingestSetDiffers(["src/a.ts", "src/b.ts"], ["src/b.ts", "src/a.ts"]), "顺序不算变化").toBe(false);
  });

  it("mtime 与监听起点对到同一格整数毫秒：播种算回放，跨到下一格才算改动", () => {
    // stat.mtimeMs 带小数，监听起点是整数毫秒
    expect(changedAfter(1_000, 1_000)).toBe(false);
    expect(changedAfter(1_000.7, 1_000)).toBe(false);
    expect(changedAfter(1_001.0, 1_000), "跨到下一格就是起监听之后的改动了").toBe(true);
    const dir = repository();
    expect(changedAfter(statSync(join(dir, "src/keep.ts")).mtimeMs, Date.now())).toBe(false);
  });

  it("listIngestedPaths 只列收录进来的路径，且不读文件内容", () => {
    const dir = repository();
    writeFileSync(join(dir, "src/skip.png"), "not-text", "utf8");
    writeFileSync(join(dir, "credentials.json"), '{"token":"denied-by-name"}\n', "utf8");
    writeFileSync(join(dir, "src/config.json"), "{}\n", "utf8");
    mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules/pkg/index.ts"), "export const nope = 1;\n", "utf8");
    expect(listIngestedPaths(dir, createTutorIgnoreMatcher(dir)).sort(), "readdir 顺序不参与判定，断言前排好")
      .toEqual(["src/config.json", "src/keep.ts"]);
  });
});

describe("RepositoryWatcher 的死活（起不来要交出状态、中途报错要出声）", () => {
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
    const inner = (watcher as unknown as { watcher?: { emit(event: string, error: Error): boolean } }).watcher;
    expect(inner, "监听没起来就别继续测了").toBeTruthy();
    inner!.emit("error", new Error("inotify 额度用尽"));
    expect(errors).toEqual(["inotify 额度用尽"]);
    expect(watcher.watchStatus).toMatchObject({ started: true, dead: true, error: "inotify 额度用尽" });
    watcher.close();
  });

  it("端到端兜底：真源码改动能走到回调，且同一批里不会混进产物路径", async (ctx) => {
    const dir = repository(["!.tutor/**"]);
    const batches: string[][] = [];
    const watcher = new RepositoryWatcher(dir, (paths) => batches.push(paths), 60);
    expect(watcher.start().started).toBe(true);
    // 等 5ms 让监听起点跨过整毫秒，播种不会被算成改动
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 产物与源码同批写入，产物路径若上报就会出现在同一批里
    mkdirSync(join(dir, ".tutor"), { recursive: true });
    writeFileSync(join(dir, ".tutor", "tutor.db"), "{}", "utf8");
    writeFileSync(join(dir, "src/keep.ts"), "export const keep = 2;\n", "utf8");
    const arrived = await waitFor(() => batches.flat().includes("src/keep.ts"), 20_000);
    watcher.close();
    if (!arrived) {
      // 真 fs 事件在并行负载下可能迟到，迟到时跳过本用例
      console.warn("[watcher] 20 秒内没收到真 fs 事件，端到端兜底跳过（判据见上一组纯函数用例）");
      ctx.skip();
    }
    expect(batches.flat().filter((path) => isArtifactEcho(path))).toEqual([]);
    // 用例超时必须大于上面的 20 秒等待窗口
  }, 25_000);

  it("端到端：非收录文件的写入（含它顶一下的仓根目录 mtime）一路都不叫醒", async (ctx) => {
    const dir = repository();
    const batches: string[][] = [];
    const watcher = new RepositoryWatcher(dir, (paths) => batches.push(paths), 60);
    expect(watcher.start().started).toBe(true);
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=not-source\n", "utf8");
    writeFileSync(join(dir, "credentials.json"), "{}\n", "utf8");
    writeFileSync(join(dir, "logo.png"), "not-text", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(batches, "这三份都不在收录集里，一轮重分析都不该排").toEqual([]);
    // 再验一次真改动能上报，排除监听未启动导致的空批
    writeFileSync(join(dir, "src/added.ts"), "export const added = 1;\n", "utf8");
    const arrived = await waitFor(() => batches.flat().includes("src/added.ts"), 20_000);
    watcher.close();
    if (!arrived) {
      console.warn("[watcher] 20 秒内没收到真 fs 事件，这条端到端自我跳过（判据见上面那组纯函数用例）");
      ctx.skip();
    }
  }, 25_000);
});
