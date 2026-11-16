import { afterEach, describe, expect, it } from "vitest";

import { proxyFor } from "./proxy-fetch.js";

const KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("出站代理选择", () => {
  it("配了代理就走；NO_PROXY 命中的地址直连", () => {
    for (const key of KEYS) delete process.env[key];
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    process.env.NO_PROXY = "localhost,127.0.0.1,.internal";
    expect(proxyFor("https://api.example.com/v1")).toBe("http://127.0.0.1:7890");
    expect(proxyFor("http://127.0.0.1:3001/x")).toBeUndefined();
    expect(proxyFor("https://svc.internal/v1")).toBeUndefined();
  });

  it("没配代理直连；非法地址也不走代理", () => {
    for (const key of KEYS) delete process.env[key];
    expect(proxyFor("https://api.example.com/v1")).toBeUndefined();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    expect(proxyFor("not a url")).toBeUndefined();
  });
});
