import { describe, expect, it } from "vitest";
import { maskSecrets, SECRET_MASK, secretMasker } from "./secret-filter.js";

/**
  密钥名单的直测。原先只有消费方（取码、摘录、出题、回合复检）间接覆盖它：
  红的时候分不清是名单坏了还是消费方接错了，而这份判据的安全含义不该靠旁证撑着。
  正反例都取自文件头那句「误伤 `YOUR_KEY` 等于毁掉教学正文」。
*/
describe("maskSecrets", () => {
  it("高信号形态逐个命中，原文一律换成占位", () => {
    const samples = [
      `sk-${"A".repeat(20)}`,
      `ghp_${"a".repeat(24)}`,
      `github_pat_${"a".repeat(24)}`,
      `AKIA${"ABCDEFGHIJKLMNOP"}`,
      `AIza${"a".repeat(31)}`,
      `xoxb-${"a".repeat(12)}`,
      `eyJ${"a".repeat(14)}.${"b".repeat(10)}`,
      `api_key = ${"a".repeat(22)}`
    ];
    for (const sample of samples) {
      const screened = maskSecrets(`前缀 ${sample} 后缀`);
      expect(screened.text, sample).toBe(`前缀 ${SECRET_MASK} 后缀`);
      expect(screened.masked, sample).toBe(1);
    }
  });

  it("私钥整段一起隐去；只有起始行的残块也至少标记不漏", () => {
    const block = ["-----BEGIN RSA PRIVATE KEY-----", `MIIEowIBAAKCAQEA${"x".repeat(64)}`, "-----END RSA PRIVATE KEY-----"].join("\n");
    expect(maskSecrets(block).text).toBe(SECRET_MASK);
    const orphan = maskSecrets(`-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEowIBAAKCAQEA${"x".repeat(64)}`);
    expect(orphan.text).toContain(SECRET_MASK);
    expect(orphan.masked).toBeGreaterThan(0);
  });

  it("讲解代码里的占位名与小写赋值不误伤", () => {
    const benign = ["把 YOUR_KEY 换成你的密钥", 'const token = config.get("x")', "password 字段请不要写进日志", "sk-short", "gh_short_prefix_ok"];
    for (const text of benign) {
      const screened = maskSecrets(text);
      expect(screened.masked, text).toBe(0);
      expect(screened.text, text).toBe(text);
    }
  });
});

describe("secretMasker", () => {
  it("逐行消费方也能整块隐去私钥（靠行状态，不靠跨行正则）", () => {
    const masker = secretMasker();
    const lines = ["-----BEGIN RSA PRIVATE KEY-----", `MIIEowIBAAKCAQEA${"x".repeat(64)}`, "-----END RSA PRIVATE KEY-----", "结尾一行"];
    const taken = lines.map((line) => masker.take(line));
    expect(taken.slice(0, 3)).toEqual([SECRET_MASK, SECRET_MASK, SECRET_MASK]);
    expect(taken[3]).toBe("结尾一行");
    expect(masker.masked).toBe(3);
  });

  it("命中数累加进同一份读数（`code_egress` 只认这一份，多算少算都是虚报）", () => {
    const masker = secretMasker();
    masker.take(`key sk-${"A".repeat(20)}`);
    masker.take(`again ghp_${"a".repeat(24)}`);
    expect(masker.masked).toBe(2);
  });
});
