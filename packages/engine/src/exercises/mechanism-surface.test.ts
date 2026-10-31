import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { excerptClues, mechanismCandidate, tagTokens } from "./mechanism-surface.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** 一张表（有独有键名）、两份配置（共享词「redis」）、一份不该被收的文档。 */
function demoRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "codebase-tutor-mechanism-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "sql"), { recursive: true });
  mkdirSync(join(root, "infra"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "sql", "schema.sql"), [
    "CREATE TABLE voucher (",
    "  id BIGINT NOT NULL AUTO_INCREMENT,",
    "  stock INT NOT NULL,",
    "  PRIMARY KEY (id),",
    "  UNIQUE KEY uk_user (user_id, voucher_id),",
    "  KEY idx_stock (stock)",
    ") ENGINE=InnoDB;",
    "",
    "ALTER TABLE orders ADD COLUMN note TEXT;",
    ""
  ].join("\n"));
  writeFileSync(join(root, "infra", "pool.properties"), [
    "# 连接池与超时",
    "redis.timeout=3000ms",
    "redis.pool.max-wait=200ms",
    "# 下面这行没有等号，不算声明",
    "unrelated prose"
  ].join("\n"));
  writeFileSync(join(root, "infra", "cache.properties"), [
    "redis.host=127.0.0.1",
    "redis.port=6379",
    "redis.database=1"
  ].join("\n"));
  writeFileSync(join(root, "docs", "notes.md"), ["CREATE TABLE not_a_source_file (", "  id INT", ");"].join("\n"));
  return root;
}

describe("机制声明面", () => {
  it("线索接不上就不补；接得上时按键名所在那块选", () => {
    const root = demoRepo();
    expect(mechanismCandidate(root, tagTokens("库存 扣减"), new Set()), "没有一条线索命中就不该多塞一段").toBeUndefined();
    const pool = mechanismCandidate(root, tagTokens("max-wait 配置"), new Set());
    expect(pool?.candidate.path, "键名命中优先，与声明行数无关").toBe("infra/pool.properties");
    expect(pool?.candidate.excerpt).toContain("redis.pool.max-wait");
  });

  it("独有的名字压过人人都撞的共享词，声明多也不买账", () => {
    const found = mechanismCandidate(demoRepo(), [...tagTokens("redis uk_user"), "voucher"], new Set());
    expect(found?.candidate.path, "「redis」被两块撞上所以变轻，uk_user 与 voucher 只在这张表里").toBe("sql/schema.sql");
    expect(found?.candidate.excerpt).toContain("uk_user");
  });

  it("已经在池子里的文件不重复给；文档与孤立声明都不算素材", () => {
    const root = demoRepo();
    const clues = [...tagTokens("max-wait"), ...excerptClues([{ path: "src/a.js", lineCount: 1, excerpt: "const ukUser = uk_user;" }])];
    const found = mechanismCandidate(root, clues, new Set(["infra/pool.properties"]));
    expect(found?.candidate.path, "配置被占走后按 uk_user 落到表上").toBe("sql/schema.sql");
    const excerpt = found?.candidate.excerpt ?? "";
    expect(excerpt, "文档不进声明面").not.toContain("not_a_source_file");
    expect(excerpt, "单独一行声明不单独成块").not.toContain("ALTER TABLE orders");
  });

  it("摘录区间只覆盖声明块，内容哈希与收录集同一形状", () => {
    const found = mechanismCandidate(demoRepo(), tagTokens("uk_user"), new Set());
    expect(found?.candidate.startLine).toBe(1);
    expect(found?.candidate.endLine, "块尾止于最后一行声明").toBeLessThanOrEqual(6);
    expect(found?.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("线索取自摘录：丢语言关键字，按出现次数排，可截断", () => {
    const clues = excerptClues([{ path: "a.js", lineCount: 2, excerpt: "const voucherId = voucherId + voucherId;\nfunction later() { return voucherId; }" }], 2);
    expect(clues, "按出现次数排，limit 之后不再补").toEqual(["voucherid", "later"]);
  });

  it("没有声明面可补时就不补，不硬凑一个文件进来", () => {
    const root = mkdtempSync(join(tmpdir(), "codebase-tutor-mechanism-empty-"));
    temporaryDirectories.push(root);
    writeFileSync(join(root, "app.js"), "export const voucherCacheTtl = 1;\n");
    expect(mechanismCandidate(root, tagTokens("voucherCacheTtl"), new Set())).toBeUndefined();
  });

  it("同一份产物两次挑同一处：选料不稳定就会每次重付", () => {
    const root = demoRepo();
    const clues = tagTokens("max-wait 配置");
    expect(mechanismCandidate(root, clues, new Set())).toEqual(mechanismCandidate(root, clues, new Set()));
  });
});
