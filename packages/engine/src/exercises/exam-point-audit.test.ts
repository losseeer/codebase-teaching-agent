import { describe, expect, it } from "vitest";

import { buildAuditSamples, decideTier, tiersOfDecisions, type ReadyPointAudit } from "./exam-point-audit.js";
import type { Landing } from "./exam-points.js";

const landings = (count: number): Landing[] => Array.from({ length: count }, (_, index) => ({
  path: `src/F${index}.java`, pointId: "java.boxed-equality", line: index + 1, signal: count - index
}));

describe("抽检样本门槛", () => {
  it("命中 <10 不定档，标 insufficient", () => {
    const audit = buildAuditSamples("java.boxed-equality", landings(9));
    expect("decision" in audit && audit.decision).toBe("insufficient");
    expect(audit.hits).toBe(9);
  });

  it("命中 ≥10 时 A 取前 20、B 从剩余确定性取样", () => {
    const audit = buildAuditSamples("java.boxed-equality", landings(55)) as ReadyPointAudit;
    expect(audit.hits).toBe(55);
    expect(audit.samples.filter((item) => item.group === "A")).toHaveLength(20);
    expect(audit.samples.filter((item) => item.group === "B").length).toBeGreaterThan(0);
    expect(audit.samples[0]!.signal).toBeGreaterThanOrEqual(audit.samples.at(-1)!.signal);
    expect(buildAuditSamples("java.boxed-equality", landings(55)).samples).toEqual(audit.samples); // 可复现
  });
});

describe("六分支处置", () => {
  it("A≥50% 启用；A 25–50% 进观察区，连续 3 轮才降灰区", () => {
    expect(decideTier(0.6, 0.1)).toBe("enabled");
    expect(decideTier(0.3, 0.2, 1)).toBe("observe");
    expect(decideTier(0.3, 0.2, 3)).toBe("grey");
  });

  it("A 低 B 更低 -> 停用；B 中等 -> 降灰区；B 高 -> 调 signal 不停用", () => {
    expect(decideTier(0.1, 0.1)).toBe("disabled");
    expect(decideTier(0.1, 0.35)).toBe("grey");
    expect(decideTier(0.1, 0.7)).toBe("tune_signal");
  });

  it("档位汇总成 PointTiers；观察区/待调 signal 的条目保持启用", () => {
    const tiers = tiersOfDecisions({
      a: "enabled", b: "observe", c: "tune_signal", d: "insufficient", e: "grey", f: "disabled"
    });
    expect(tiers.enabled).toEqual(["a", "b", "c", "d"]);
    expect(tiers.grey).toEqual(["e"]);
    expect(tiers.disabled).toEqual(["f"]);
  });
});
