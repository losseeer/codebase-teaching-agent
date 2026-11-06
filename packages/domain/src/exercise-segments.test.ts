/** 出题分段帧的识别规则。 */
import { describe, expect, it } from "vitest";

import { EXERCISE_SEGMENT_ACTIVE, EXERCISE_SEGMENT_LABEL, EXERCISE_SEGMENTS, exerciseSegmentOf } from "./exercise-segments.js";

describe("exerciseSegmentOf", () => {
  it("从 stepId 的段前缀认出是哪一段", () => {
    expect(exerciseSegmentOf("prompt-m1")).toBe("prompt");
    expect(exerciseSegmentOf("code-1")).toBe("code");
    expect(exerciseSegmentOf("tests-1")).toBe("tests");
  });

  it("段内重出带序号（prompt-2-m1）仍认得出段", () => {
    expect(exerciseSegmentOf("prompt-2-m1")).toBe("prompt");
    expect(exerciseSegmentOf("code-2-m1")).toBe("code");
  });

  it("不是分段帧就返回 undefined", () => {
    expect(exerciseSegmentOf("m1")).toBeUndefined();
    expect(exerciseSegmentOf("journal-model-1")).toBeUndefined();
    expect(exerciseSegmentOf(undefined)).toBeUndefined();
  });

  it("三段各有一套名字：名词性给文案，进行时给进度与轨迹", () => {
    expect(EXERCISE_SEGMENTS.map((segment) => EXERCISE_SEGMENT_LABEL[segment])).toEqual(["拟题面", "写实现", "写测试"]);
    expect(EXERCISE_SEGMENTS.map((segment) => EXERCISE_SEGMENT_ACTIVE[segment])).toEqual(["正在拟题面", "正在写实现", "正在写测试"]);
  });
});
