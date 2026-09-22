import { describe, expect, it } from "vitest";
import { buildRecentChangesSection } from "./recent-changes.js";

/** 固定「现在」，测试不依赖真实时钟。 */
const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const iso = (ageMs: number): string => new Date(NOW - ageMs).toISOString();

const MINUTE = 60_000;
const HOUR = 3_600_000;

describe("buildRecentChangesSection", () => {
  it("新鲜的变更记录 → 改动清单 + 排除自身后的波及清单", () => {
    const section = buildRecentChangesSection({
      lastIncrementalUpdate: {
        changedPaths: ["src/io/FileService.java"],
        impactedPaths: ["src/io/FileService.java", "src/web/ApiController.java"],
        at: iso(10 * MINUTE)
      }
    }, NOW);
    expect(section).toContain("近期仓库变更");
    expect(section).toContain("10 分钟前");
    expect(section).toContain("改动文件（1）：src/io/FileService.java");
    expect(section).toContain("被其波及（1，不含改动自身）：src/web/ApiController.java");
    // impactRadius 把改动自身也算进 impactedPaths，不能再列一遍
    expect(section?.match(/FileService\.java/g)).toHaveLength(1);
    expect(section).toContain("不是证据来源");
  });

  it("波及只有改动自身时省略波及行；刚刚检测到的措辞不带「于」", () => {
    const section = buildRecentChangesSection({
      lastIncrementalUpdate: { changedPaths: ["a.py"], impactedPaths: ["a.py"], at: iso(3_000) }
    }, NOW);
    expect(section).toContain("本地文件监听刚刚检测到");
    expect(section).not.toContain("波及");
  });

  it("超过 72 小时的记录不注入：那是仓库历史，不是「近期」", () => {
    expect(buildRecentChangesSection({
      lastIncrementalUpdate: { changedPaths: ["a.py"], impactedPaths: ["a.py"], at: iso(72.5 * HOUR) }
    }, NOW)).toBeUndefined();
  });

  it("无记录 / 空改动 / 坏时间戳都不注入", () => {
    expect(buildRecentChangesSection({}, NOW)).toBeUndefined();
    expect(buildRecentChangesSection({ lastIncrementalUpdate: { changedPaths: [], impactedPaths: [], at: iso(MINUTE) } }, NOW)).toBeUndefined();
    expect(buildRecentChangesSection({ lastIncrementalUpdate: { changedPaths: ["a.py"], impactedPaths: [], at: "不是时间" } }, NOW)).toBeUndefined();
  });

  it("清单超 8 个截断并如实报未列出条数（路径全列会把参考段撑成正文）", () => {
    const many = Array.from({ length: 11 }, (_, index) => `src/p/f${index}.java`);
    const section = buildRecentChangesSection({
      lastIncrementalUpdate: { changedPaths: many.slice(0, 9), impactedPaths: many, at: iso(2 * HOUR) }
    }, NOW);
    expect(section).toContain("改动文件（9）");
    expect(section).toContain("另有 1 个未列出");
    expect(section).toContain("被其波及（2，不含改动自身）");
    expect(section).toContain("2 小时前");
  });
});
