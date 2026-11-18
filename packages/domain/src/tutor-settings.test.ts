import { describe, expect, it } from "vitest";

import { policyFor } from "./tutor-settings.js";

describe("教学档位策略", () => {
  it("讲解档只解释、不追问", () => {
    const text = policyFor({ pedagogy: "explanatory", depth: "macro" }).constraints.join(" ");
    expect(text).toContain("不追加问题");
    expect(text).not.toContain("复述");
  });

  it("引导档仍保留可验证的问题", () => {
    const text = policyFor({ pedagogy: "socratic", depth: "macro" }).constraints.join(" ");
    expect(text).toContain("可验证的问题");
  });
});
