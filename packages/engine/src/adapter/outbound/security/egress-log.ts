import { hash, repositoryId as deriveRepositoryId } from "@codebase-tutor/platform";
import { Journal } from "../persistence/journal.js";

/** 源码出网清单：哪些仓内代码片段、以什么形态、进了哪一次模型请求。
    只记指针与指纹（`chars + hash`），不记正文。
    一行 = 一段源码，只在真的发出时写；未发出的分支不记，端点失败照记。 */

/** 出网形态：按装配路径区分。 */
export type EgressKind =
  /** L1 文件摘要用的结构切片：行数、符号名与参数、依赖方向，不含整份正文。 */
  | "l1-slice"
  /** 锚点附近的源码摘录。 */
  | "anchor-excerpt"
  /** 流程视图用的入口文件与推断边窗口。 */
  | "flow-window"
  /** 出题与题面润色用的源码摘录。 */
  | "exercise-excerpt"
  /** 沙箱运行输出：学习者写的代码与 stdout/stderr 摘要。 */
  | "sandbox-output";

export interface EgressSource {
  kind: EgressKind;
  /** 仓内相对路径（与 `file_read` 的 `path` 同口径） */
  path: string;
  /** 实际发出去的行区间（含端点） */
  from: number;
  to: number;
  /** 进请求的那段文本，只用于算 `chars` 与 `hash`。 */
  text: string;
  /** 隐去的疑似密钥处数；`0` 与缺字段含义不同。 */
  masked?: number;
  /** 被字符/行上限切短。 */
  truncated?: boolean;
}

/** 装配侧收集待发段落的清单。 */
export type EgressCollector = EgressSource[];

/** 计入审计：一次装配写 N 行；给了 `sent` 就只登记其中确实还存在的那些段。 */
export function recordEgress(input: { repositoryPath: string; scene: string; sessionId?: string; sources: EgressSource[]; sent?: string }): void {
  const sent = input.sent;
  const sources = sent === undefined
    ? input.sources
    // 空 text 不算一段，避免 includes("") 恒真
    : input.sources.filter((source) => source.text.length > 0 && sent.includes(source.text));
  if (!sources.length) return;
  const journal = new Journal(input.repositoryPath, deriveRepositoryId(input.repositoryPath));
  for (const source of sources) {
    journal.append("code_egress", {
      scene: input.scene,
      kind: source.kind,
      path: source.path,
      lines: `${source.from}-${source.to}`,
      chars: source.text.length,
      hash: hash(source.text).slice(0, 12),
      // masked 为 0 也要写：区分扫过零命中与没扫
      ...(source.masked === undefined ? {} : { masked: source.masked }),
      ...(source.truncated ? { truncated: true } : {})
    }, input.sessionId);
  }
}
