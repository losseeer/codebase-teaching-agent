import { describe, expect, it } from "vitest";
import { policyFor, validateSettings } from "./policy.js";

describe("continuous tutor policy", () => {
  it("keeps pedagogy and depth independent from the style spectrum", () => {
    const settings = validateSettings({ style: 82, pedagogy: "practice", depth: "micro" });
    const policy = policyFor(settings);
    expect(policy.level).toBe(82);
    expect(policy.pedagogy).toBe("practice");
    expect(policy.depth).toBe("micro");
    expect(policy.constraints.join(" ")).toContain("可执行的观察任务");
  });

  it("clamps style without reconstructing other settings", () => {
    expect(validateSettings({ style: 999, pedagogy: "explanatory", depth: "macro" })).toEqual({ style: 100, pedagogy: "explanatory", depth: "macro" });
  });
});
