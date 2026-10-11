/**
  密钥形态的**唯一一份**判据。两处消费方必须同源，否则迟早漂移：
  - `source/read-file.ts`：入口——文件正文进发往远端的 prompt 之前先隐去；
  - `eval/scorers.ts` 的 `screenReply`：出口——模型回复进对话与落库之前再筛一遍
    （学习者自己贴进来的报错、上一轮正文里带回来的，只有这一道挡得住）。

  只收**高信号**形态：宁可漏，不可误伤——把 `YOUR_KEY`、`token = config.get("x")` 这类正常讲代码的字样改掉，
  等于毁掉教学正文的可读性。命中一律换成固定占位文本，**原文绝不落任何日志**。
 */
export const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / DeepSeek 一类的 key 形态
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}/g, // 云厂商临时凭据
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/g, // JWT 两段连写（头部解出来就是 eyJ 开头的固定形态）
  /\b(?:api[_-]?key|access[_-]?key|secret[_-]?key|password|token)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{20,}/gi
];

export const SECRET_MASK = "[疑似密钥，已隐去]";

/** 隐去所有命中并回报数量。调用方只拿得到数量，拿不到原文。 */
export function maskSecrets(text: string): { text: string; masked: number } {
  let masked = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replaceAll(pattern, () => {
      masked += 1;
      return SECRET_MASK;
    });
  }
  return { text: out, masked };
}
