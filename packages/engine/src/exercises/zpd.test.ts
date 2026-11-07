import { describe, expect, it } from "vitest";
import type { MasteryLevel, MasteryRecord } from "@codebase-tutor/domain";

import { selectZpdTarget } from "./zpd.js";

const target = (id: string, difficulty: MasteryLevel, selfContained: number) => ({ id, title: id, value: id, difficulty, selfContained });

/** 掌握度钉在 3 档，候选都在 ±1 之内。 */
const records: MasteryRecord[] = [{ unitId: "u", level: 3 as MasteryLevel, attempts: 1, successes: 0 }];

describe("ZPD 的自包含度 tie-break", () => {
  it("同难度时跨文件依赖少的优先", () => {
    const picked = selectZpdTarget([target("a", 3 as MasteryLevel, 20), target("b", 3 as MasteryLevel, 0)], records);
    expect(picked?.id).toBe("b");
  });

  it("难度距离优先于自包含度（不改变 ZPD 语义）", () => {
    const picked = selectZpdTarget([target("far", 4 as MasteryLevel, 0), target("near", 3 as MasteryLevel, 20)], records);
    expect(picked?.id).toBe("near");
  });

  it("没有 selfContained 时退回原排序（按 id），行为不变", () => {
    const picked = selectZpdTarget([
      { id: "b", title: "b", value: "b", difficulty: 3 as MasteryLevel },
      { id: "a", title: "a", value: "a", difficulty: 3 as MasteryLevel }
    ], records);
    expect(picked?.id).toBe("a");
  });
});
