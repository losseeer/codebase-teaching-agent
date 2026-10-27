/**
  模型这一侧「能塞多少」的唯一真源。

  只有一个手填数：上下文窗口（token）。各处预算都从它按份额派生，不再各写一个字符常数——
  窗口变了，全部预算跟着变，不会出现「改了窗口忘了改摘录」这种分叉。
  每次调用现读环境变量：与外部工具超时同一口径，调完不必重启。
*/

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** 字符 → token 的粗标定：与导入清单那把尺一致（`summarizer` 估输入用的就是字符 ÷ 4）。 */
export const CHARS_PER_TOKEN = 4;

/**
  一份请求里各类内容占窗口的份额。加起来刻意远小于 1：
  剩下的留给模型自己的输出与工具循环往后几轮的累积——一轮 read_file 就能再加一大块。
*/
export const CONTEXT_SHARE = {
  /** 单次 read_file 的上限（整份源码通常远小于它）。 */
  fileRead: 0.08,
  /** 单次 query_facts 的上限（产物读数按指针给，不整仓给）。 */
  factsQuery: 0.05,
  /** 锚点摘录的总预算：摘录是「定位用的上下文」，不是全文阅读。 */
  anchorExcerpts: 0.02,
  /** 项目结构全景（按目录分组的文件清单）的预算。 */
  panorama: 0.02,
  /** 宏观设计回合的整段上下文（全景 + 依赖邻接 + 摘录 + 历史）。 */
  mapContext: 0.06,
  /** 练习答疑回合的整段上下文（题面为主，比宏观设计小）。 */
  practiceContext: 0.04,
  /** 代码问答回合的整段上下文（作用域清单 + 调用邻接 + 摘录 + 近期对话）。 */
  teachingContext: 0.03,
  /** 最近对话与折叠段回填的预算。 */
  conversation: 0.05,
  /** 单个符号摘录的行数上限：超过只取符号开头（花括号计数的 endLine 会虚高）。 */
  symbolLines: 0.002,
  /** 单个摘录块的字符上限。 */
  excerptBlock: 0.004
} as const;

export function contextWindowTokens(): number {
  const raw = Number(process.env.TUTOR_CONTEXT_WINDOW_TOKENS ?? DEFAULT_CONTEXT_WINDOW_TOKENS);
  return Number.isFinite(raw) && raw >= 8_000 ? Math.floor(raw) : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** 窗口份额换算成字符预算。不设地板：配了多小的窗口就按多小的预算办事，截断由各处如实说明。 */
export function contextShare(share: number): number {
  return Math.floor(contextWindowTokens() * CHARS_PER_TOKEN * share);
}

/** 行数形式的预算：按代码平均行长折算（单次读取真正花光预算的是字符，不是行）。 */
export function contextShareLines(share: number, averageLineChars = 40): number {
  return Math.floor(contextShare(share) / averageLineChars);
}
