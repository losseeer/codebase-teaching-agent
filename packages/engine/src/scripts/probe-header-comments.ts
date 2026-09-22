import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexRepository } from "../indexer/indexer.js";
import { extractHeaderComment } from "../summarizer/slice.js";

/**
  零 token 探针：「摘要参考注释」开档实际会往切片里塞什么。
  输出：每仓「有 headerComment 的文件数 / 总文件数」+ 全部抽到的注释清单（截 90 字）。
  「新/旧」标记 = 该注释开头是否已出现在参照 cohort（COHORT_BEFORE 之前生成的最新一行摘要）里；
  不设 COHORT_BEFORE 时全标「?」。只读打开 <仓>/.tutor/tutor.db。
  用法：COHORT_BEFORE=2026-09-22T11:00 npx tsx src/scripts/probe-header-comments.ts <仓库路径> [...]
*/

const cohortBefore = process.env.COHORT_BEFORE;

for (const repositoryPath of process.argv.slice(2)) {
  const index = indexRepository(repositoryPath);
  const summaryByPath = new Map<string, string>();
  const dbFile = join(repositoryPath, ".tutor", "tutor.db");
  if (cohortBefore && existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db.prepare("select summary from summaries where created_at < ? order by created_at asc").all(cohortBefore) as { summary: string }[];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.summary) as { path?: string; summary?: string };
        if (parsed.path && parsed.summary) summaryByPath.set(parsed.path, parsed.summary);
      } catch { /* 非 JSON 行忽略 */ }
    }
    db.close();
  }
  let withComment = 0;
  const lines: string[] = [];
  for (const file of index.files) {
    const path = file.path;
    try {
      const text = readFileSync(join(repositoryPath, path), "utf8");
      const header = extractHeaderComment(path, text);
      if (!header) continue;
      withComment += 1;
      const old = summaryByPath.get(path);
      const mark = cohortBefore ? (old && old.includes(header.slice(0, 12)) ? "旧" : "新") : "?";
      lines.push(`${mark} ${path} :: ${header.slice(0, 90)}`);
    } catch {
      /* 文件读不到就跳过 */
    }
  }
  console.log(`\n=== ${repositoryPath}：${withComment}/${index.files.length} 文件有可取的首段注释`);
  for (const line of lines.sort()) console.log(line);
}
