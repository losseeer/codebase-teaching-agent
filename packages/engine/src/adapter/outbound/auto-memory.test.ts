import { describe, expect, it } from "vitest";

import { parseMemory } from "./auto-memory.js";

describe("画像记忆提炼", () => {
  it("只认 JSON 形式的一条记忆；空、超长与乱码都不算", () => {
    expect(parseMemory('{"memory":"偏好严谨、具体的中文技术表达"}')).toBe("偏好严谨、具体的中文技术表达");
    expect(parseMemory('{"memory":null}')).toBeUndefined();
    expect(parseMemory("没有值得记的")).toBeUndefined();
    expect(parseMemory(`{"memory":"${"长".repeat(90)}"}`)).toBeUndefined();
    expect(parseMemory("{坏的 JSON")).toBeUndefined();
  });
});
