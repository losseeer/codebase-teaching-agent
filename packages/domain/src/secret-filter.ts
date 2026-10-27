/**
  密钥形态的唯一判据。整段文本的消费方走 `maskSecrets`：`source/read-file.ts`（文件正文进 prompt 前）、
  `llm/provider.ts` 的 `screenOutbound`（出网最后一道，含工具参数与 reasoning）、`application/turn-invariants.ts` 的 `screenReply`
  （模型回复进对话与落库前再筛一遍——学习者贴进来的报错、上一轮正文带回来的，只有这一道挡得住）。
  逐行取段的消费方走 `secretMasker`：`source/excerpt.ts`、`exercises/llm-generate.ts`、`exercises/code-generate.ts`、`summarizer/summarizer.ts`。

  只收高信号形态：误伤 `YOUR_KEY`、`token = config.get("x")` 这类讲解代码的字样，等于毁掉教学正文的可读性。
  命中一律换成固定占位文本，原文绝不落任何日志。

  为什么住内核而不是出站目录：这是文本形状的策略判断，不碰文件也不碰网络；九个消费方里六个在内层
  （取码、摘录、出题、摘要、回合复检），为了拿一个筛子伸进 `adapter/outbound/` 就等于把判据挂在传输层上。
 */
export const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / DeepSeek 一类的 key 形态
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}/g, // 云厂商临时凭据
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/g,
  // 私钥块的正文是逐行 base64，任何单行模式都认不出它：整段 BEGIN…END 一起隐去。
  // 反向引用要求结束行与起始行同名（不配对就退化成只隐去起始行标记），跨度上限 20000 字符：
  // 没有 END 的残块、以及超过上限的超大块，正文仍会漏出——逐行过筛的一方（`secretMasker`）靠行状态补这个洞。
  /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]{0,20000}?-----END \1-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // 只有起始行的残块：至少标记本身不漏
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

/**
  逐段（一行或一个字段）过筛，把命中数累加进同一份计数：`masked` 会进 journal 的 `code_egress`，
  多算少算都是虚报。做成可反复调用的累加器而不是一次性 `map`，是因为摘录要在字符预算耗尽时中断循环。
*/
export function secretMasker(): { take: (text: string) => string; masked: number } {
  let inPem = false;
  const state = {
    masked: 0,
    take(text: string): string {
      // 逐行消费方拿不到整段文本，跨行模式在这里永远命中不了：私钥块改由行状态判（BEGIN 起、END 收）
      if (inPem || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
        if (/-----END [A-Z ]*PRIVATE KEY-----/.test(text)) inPem = false;
        else inPem = true;
        state.masked += 1;
        return SECRET_MASK;
      }
      const screened = maskSecrets(text);
      state.masked += screened.masked;
      return screened.text;
    }
  };
  return state;
}
