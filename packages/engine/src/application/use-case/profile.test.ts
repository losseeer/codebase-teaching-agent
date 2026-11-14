import { describe, expect, it } from "vitest";

import { parseProfileUpdate } from "./profile.js";

describe("画像更新解析", () => {
  it("接受一条回话与全文；缺全文、超长、坏 JSON 都不算", () => {
    expect(parseProfileUpdate('{"reply":"已记住表达偏好","profile":"## 表达偏好\\n严谨、具体。"}')).toEqual({ reply: "已记住表达偏好", profile: "## 表达偏好\n严谨、具体。" });
    expect(parseProfileUpdate('{"reply":"没有回话","profile":"## 表达偏好"}')?.reply).toBe("没有回话");
    expect(parseProfileUpdate('{"reply":"x"}')).toBeUndefined();
    expect(parseProfileUpdate(`{"reply":"x","profile":"${"长".repeat(4001)}"}`)).toBeUndefined();
    expect(parseProfileUpdate("不是 JSON")).toBeUndefined();
  });
});
