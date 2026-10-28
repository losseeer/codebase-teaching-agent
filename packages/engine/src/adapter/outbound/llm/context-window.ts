/** 模型侧容量入口：唯一手填数是上下文窗口 token，各处预算按份额派生。 */

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

/** 字符 → token 的换算系数。 */
export const CHARS_PER_TOKEN = 4;

/** 一份请求里各类内容占窗口的份额。 */
export const CONTEXT_SHARE = {
  /** 单次 read_file 的字符上限。 */
  fileRead: 0.08,
  /** 单次 query_facts 的字符上限。 */
  factsQuery: 0.05,
  /** 锚点摘录的总预算。 */
  anchorExcerpts: 0.02,
  /** 项目结构全景（按目录分组的文件清单）的预算。 */
  panorama: 0.02,
  /** 宏观设计回合的整段上下文（全景 + 依赖邻接 + 摘录 + 历史）。 */
  mapContext: 0.06,
  /** 练习答疑回合的整段上下文。 */
  practiceContext: 0.04,
  /** 代码问答回合的整段上下文（作用域清单 + 调用邻接 + 摘录 + 近期对话）。 */
  teachingContext: 0.03,
  /** 最近对话与折叠段回填的预算。 */
  conversation: 0.05,
  /** 单个符号摘录的行数上限：超出只取符号开头。 */
  symbolLines: 0.002,
  /** 单个摘录块的字符上限。 */
  excerptBlock: 0.004
} as const;

export function contextWindowTokens(): number {
  const raw = Number(process.env.TUTOR_CONTEXT_WINDOW_TOKENS ?? DEFAULT_CONTEXT_WINDOW_TOKENS);
  return Number.isFinite(raw) && raw >= 8_000 ? Math.floor(raw) : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** 窗口份额换算成字符预算；不设下限。 */
export function contextShare(share: number): number {
  return Math.floor(contextWindowTokens() * CHARS_PER_TOKEN * share);
}

/** 行数形式的预算：按平均行长折算。 */
export function contextShareLines(share: number, averageLineChars = 40): number {
  return Math.floor(contextShare(share) / averageLineChars);
}
