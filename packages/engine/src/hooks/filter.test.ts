import { describe, expect, it } from "vitest";
import { filterTeachMoment } from "./filter.js";

describe("local hook filter", () => {
  it("accepts failing tool events without model inference", () => {
    const result = filterTeachMoment({ tool: "test", exitCode: 1, output: "AssertionError" });
    expect(result.accepted).toBe(true);
    expect(result.latencyMs).toBeLessThan(500);
  });
});
