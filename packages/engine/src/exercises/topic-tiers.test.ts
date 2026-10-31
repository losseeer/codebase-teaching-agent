import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { NO_TOPICS, OFF_TIER, topicIndex, validTierOf } from "./topic-tiers.js";

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../skills", "exercise-code-concepts");

/** 出厂技能的真文件：分解表的形状一变，这里就该红。 */
function bundledBody(name: string, file = "SKILL.md"): string | undefined {
  if (name !== "exercise-code-concepts") return undefined;
  try {
    return readFileSync(join(SKILL_ROOT, file), "utf8");
  } catch {
    return undefined;
  }
}

function miniSkill(name: string, file = "SKILL.md"): string | undefined {
  if (name !== "exercise-code-concepts") return undefined;
  if (file === "SKILL.md") return [
    "| 主题 | 附属文件 | 最常出的缺陷形状 |",
    "| --- | --- | --- |",
    "| 传输与序列化 | `cn.md` | 超时/重试缺一个 |",
    "| 数据结构与算法 | `ds.md` | 边界条件 |"
  ].join("\n");
  if (file === "cn.md") return [
    "## 能摘出来考的（含替身怎么给）",
    "",
    "| 考点 | 摘法 | 测试怎么断 |",
    "| --- | --- | --- |",
    "| 超时与重试参数装配 | 摘装配那段 | 断言生效值 |",
    "| 去重与幂等键 | 摘算键那段 | 断言同键 |",
    "",
    "## 不要出成题的",
    "",
    "真实网络延迟、丢包。"
  ].join("\n");
  if (file === "ds.md") return [
    "## 能摘出来考的（含替身怎么给）",
    "",
    "| 考点 | 摘法 | 测试怎么断 |",
    "| --- | --- | --- |",
    "| 淘汰策略一步决策 | 摘一步决策 | 断言淘汰谁 |",
    "",
    "## 不要出成题的",
    "",
    "真实命中率。"
  ].join("\n");
  return undefined;
}

describe("主题分解表", () => {
  it("出厂技能里四档都在，每档都有可考点与判不了的性质", () => {
    const index = topicIndex(bundledBody);
    expect(index.tiers.map((tier) => tier.id)).toEqual(["os", "cn", "ds", "backend"]);
    for (const tier of index.tiers) {
      expect(tier.points.length, `${tier.id} 的可考点`).toBeGreaterThanOrEqual(3);
      expect(tier.offLimits.length, `${tier.id} 的判分边界`).toBeGreaterThan(0);
    }
    const cn = index.tiers.find((tier) => tier.id === "cn");
    expect(cn?.points).toContain("超时与重试参数装配");
    expect(cn?.points).toContain("消息路由与重试队列选择");
  });

  it("注入那段带档名、可考点、判分边界与「不得以学科体系缺失拒题」", () => {
    const prompt = topicIndex(bundledBody).prompt;
    expect(prompt).toContain("主题分解表");
    expect(prompt).toContain("cn｜传输与序列化");
    expect(prompt).toContain("只限制问哪一层，不构成拒题");
    expect(prompt).toContain(`topic_tier 填 ${OFF_TIER}`);
    expect(prompt).toContain("不得以");
    expect(prompt).toContain('"exam_point"');
  });

  it("技能没装或附属文件读不到时只丢那一档，全读不到就回空索引不编表", () => {
    expect(topicIndex(miniSkill).tiers.map((tier) => tier.id)).toEqual(["cn", "ds"]);
    expect(topicIndex((name, file) => (file === "ds.md" ? undefined : miniSkill(name, file))).tiers.map((tier) => tier.id)).toEqual(["cn"]);
    expect(topicIndex(() => undefined)).toBe(NO_TOPICS);
    expect(topicIndex((name, file) => (file ? undefined : miniSkill(name, file)))).toBe(NO_TOPICS);
    expect(topicIndex((name) => (name === "别的技能" ? "随便一张表" : undefined))).toBe(NO_TOPICS);
  });

  it("表里没有的档名不当成某一档，只当档外", () => {
    const index = topicIndex(miniSkill);
    expect(validTierOf(index, " CN ")).toBe("cn");
    expect(validTierOf(index, "计算机网络")).toBe(OFF_TIER);
    expect(validTierOf(index, "")).toBe(OFF_TIER);
  });
});
