import { describe, expect, it } from "vitest";
import { configuredOrigins, isTrustedOrigin } from "./origins.js";

/** 来源闸的边界两侧：无 Origin 与回环来源放行，其余不信。 */

describe("isTrustedOrigin", () => {
  it("没有 Origin 头就算本机调用方（curl、进程管理器、同源请求）", () => {
    expect(isTrustedOrigin(undefined, [])).toBe(true);
    // 空值头浏览器发不出来，与本机 curl 同形，按无来源放行
    expect(isTrustedOrigin("", [])).toBe(true);
  });

  it("回环来源任何端口都信，非回环一律不信", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:5199", "http://[::1]:3001", "https://localhost", "http://my-app.localhost:8080"]) {
      expect(isTrustedOrigin(origin, []), origin).toBe(true);
    }
    for (const origin of ["http://evil.example", "https://10.0.0.7:3001", "http://192.168.1.20:3000", "http://localhost.evil.example", "http://[fe80::1]:3000"]) {
      expect(isTrustedOrigin(origin, []), `${origin} 不该被当成回环`).toBe(false);
    }
  });

  it(`file:// 那类「无源」页面（Origin: null）不当成本机`, () => {
    expect(isTrustedOrigin("null", [])).toBe(false);
    expect(isTrustedOrigin("not a url", [])).toBe(false);
    expect(isTrustedOrigin("ftp://localhost", [])).toBe(false);
  });

  it("显式清单是精确匹配：大小写、结尾斜杠、多余空格都不影响命中", () => {
    const configured = configuredOrigins({ TUTOR_ALLOWED_ORIGINS: " https://Tutor.Corp.dev:8443/ ,http://10.0.0.7:3000" });
    expect(configured).toEqual(["https://tutor.corp.dev:8443", "http://10.0.0.7:3000"]);
    expect(isTrustedOrigin("https://tutor.corp.dev:8443", configured)).toBe(true);
    expect(isTrustedOrigin("https://tutor.corp.dev:8443/", configured)).toBe(true);
    expect(isTrustedOrigin("https://tutor.corp.dev", configured), "端口是来源的一部分，别把清单读成前缀匹配").toBe(false);
    expect(isTrustedOrigin("https://tutor.corp.dev.evil.example:8443", configured)).toBe(false);
  });

  it("没给 env 时清单是空的：只靠回环那一档，不会意外放宽", () => {
    expect(configuredOrigins({})).toEqual([]);
    expect(configuredOrigins({ TUTOR_ALLOWED_ORIGINS: "   " })).toEqual([]);
  });
});
