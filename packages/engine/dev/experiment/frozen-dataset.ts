/**
  [DEV ONLY] 出题实验的公共地基：冻结校验、按产物库身份挂载、质量护栏与分位数。
  design-followup 与 defect2 两个执行器共用这一份，避免同一段逻辑各写一遍。

  冻结副本是从旧目录搬来的，`.tutor/tutor.db` 里的 `repository_state.repository_id`
  与按**当前路径**算出的 `catalogRepositoryId` 不同，所以挂载必须读清单里的
  `artifactRepositoryId`，不能走 `importer.ensureMounted`。
*/
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { CodeGeneration } from "../../src/exercises/code-generate.js";
import type { ImportedRepository } from "../../src/importer/importer.js";

export interface FrozenRepo {
  name: string;
  language: string;
  path: string;
  commit: string;
  contentDigest: string;
  artifactRepositoryId: string;
}

export interface TopicRow {
  repo: string;
  type: string;
  topic: string;
  tag_id: string;
  note: string;
}

export interface Quality {
  prompt_sections_complete: boolean;
  assertion_count: number;
  defect_targeted: boolean;
  passed: boolean;
}

export function csv(path: string): Record<string, string>[] {
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const header = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
  });
}

/** 副本内容指纹：排除 .tutor / .git / .DS_Store，按相对路径排序后逐文件喂给 sha256。 */
export function contentDigestOf(base: string): string {
  const paths: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".tutor" || entry.name === ".git" || entry.name === ".DS_Store") continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), child);
      else if (entry.isFile()) paths.push(child);
    }
  };
  walk(base, "");
  const digest = createHash("sha256");
  for (const path of paths.sort()) { digest.update(`${path}\0`); digest.update(readFileSync(join(base, path))); }
  return `sha256:${digest.digest("hex")}`;
}

/** 用系统 python3 的 sqlite3 直读产物库身份；不加载 better-sqlite3，dry-run 也能校验。 */
export function artifactIdFromDb(dbPath: string): { id?: string; error?: string } {
  if (!existsSync(dbPath)) return { error: "产物库不存在" };
  const script = [
    "import sqlite3,sys",
    "con=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)",
    "row=con.execute('SELECT repository_id FROM repository_state LIMIT 1').fetchone()",
    "print(row[0] if row else '')",
    "con.close()"
  ].join(";");
  const result = spawnSync("python3", ["-c", script, dbPath], { encoding: "utf8", timeout: 10_000 });
  if (result.error) return { error: `python3 不可用：${result.error.message}` };
  if (result.status !== 0) return { error: `读产物库失败：${(result.stderr ?? "").trim().slice(0, 200)}` };
  const id = (result.stdout ?? "").trim();
  return id ? { id } : { error: "repository_state 没有行" };
}

/** 冻结校验：内容指纹 + 产物库身份都在 dry-run 现场复核，缺一即停，不静默降级。 */
export function assertFrozen(input: { root: string; repos: FrozenRepo[]; topics: TopicRow[]; expectedTopics?: number; expectedRepos?: number }): void {
  const problems: string[] = [];
  const expectedTopics = input.expectedTopics ?? 30;
  const expectedRepos = input.expectedRepos ?? 5;
  if (input.topics.length !== expectedTopics) problems.push(`主题 ${input.topics.length} 行 ≠ ${expectedTopics}`);
  if (input.topics.some((row) => row.type !== "design")) problems.push("存在非 design 行");
  if (input.repos.length !== expectedRepos) problems.push(`仓库 ${input.repos.length} ≠ ${expectedRepos}`);
  for (const repo of input.repos) {
    const full = join(input.root, repo.path);
    if (!existsSync(full)) { problems.push(`${repo.name} 副本不存在：${repo.path}`); continue; }
    if (repo.commit && !repo.contentDigest) problems.push(`${repo.name} 缺内容指纹`);
    else if (repo.contentDigest && contentDigestOf(full) !== repo.contentDigest) problems.push(`${repo.name} 内容与冻结指纹不一致：${repo.path}`);
    if (!/^repo_[0-9a-f]{16}$/.test(repo.artifactRepositoryId ?? "")) { problems.push(`${repo.name} 缺产物库身份 artifactRepositoryId`); continue; }
    const actual = artifactIdFromDb(join(full, ".tutor", "tutor.db"));
    if (actual.error) problems.push(`${repo.name} 产物库身份无法校验：${actual.error}`);
    else if (actual.id !== repo.artifactRepositoryId) problems.push(`${repo.name} 产物库身份不一致：库里 ${actual.id}，清单 ${repo.artifactRepositoryId}`);
  }
  if (problems.length) throw new Error(`数据集未冻结：\n- ${problems.join("\n- ")}`);
}

/** 按冻结的产物库 id 挂载；不重新导入、不重分析、不注册 watcher。 */
export async function mountFrozen(repo: FrozenRepo, root: string): Promise<ImportedRepository> {
  const { RepositoryHandle } = await import("../../src/adapter/outbound/persistence/repository-handle.js");
  const path = resolve(root, repo.path);
  const handle = new RepositoryHandle(path, repo.artifactRepositoryId);
  try {
    const index = handle.db.state.index(repo.artifactRepositoryId);
    const analysis = handle.db.state.analysis(repo.artifactRepositoryId);
    const estimate = handle.db.state.estimate(repo.artifactRepositoryId);
    if (!index || !analysis || !estimate) throw new Error(`state 三行不齐全（id=${repo.artifactRepositoryId}）`);
    // [DEV ONLY] 出题链路只用到 path / index / analysis / estimate / handle；其余字段不参与本实验。
    return { path, index, analysis, estimate, handle } as unknown as ImportedRepository;
  } catch (error) {
    handle.close();
    throw error;
  }
}

/** 质量护栏口径：题面三节 + 至少 2 条断言 + 下发件至少 1 条失败。 */
export function qualityOf(generation: CodeGeneration): Quality {
  if (!generation.ok) return { prompt_sections_complete: false, assertion_count: 0, defect_targeted: false, passed: false };
  const solution = generation.runs.find((run) => run.label === "solution");
  const given = generation.runs.find((run) => run.label === "given");
  const count = Math.max(
    solution?.verdict ? solution.verdict.passed + solution.verdict.failed : 0,
    given?.verdict ? given.verdict.passed + given.verdict.failed : 0
  );
  const sections = ["## 问题描述", "## 示例", "## 注意事项"].every((section) => generation.proposal.prompt.includes(section));
  const targeted = (given?.verdict?.failed ?? 0) >= 1;
  return { prompt_sections_complete: sections, assertion_count: count, defect_targeted: targeted, passed: sections && count >= 2 && targeted };
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))]!;
}
