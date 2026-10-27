import { hash, repositoryId as deriveRepositoryId } from "@codebase-tutor/platform";
import { Journal } from "../persistence/journal.js";

/**
  源码出网清单：哪些仓内代码片段、以什么形态、进了哪一次模型请求。

  两条设计口径：

  1. 记指针与指纹，不记正文。审计要回答「这段代码出过门没有、是哪一版」，把源码再抄一份进另一条日志线
     等于自己新开一个泄露面（`.tutor/` 随仓可删、可带走，正文进去就再也拿不出来）。有了 `chars + hash`，
     事后在本地把同一次装配重跑一遍比哈希，就能逐字确认「出去的就是这份」；原文不进任何日志。
  2. 一行 = 一段源码，只在真的发出时写。埋点都贴着 `provider.complete` 那一侧，
     缓存命中、预算降级、本地兜底这些没发出去的分支一行都不记——
     报了没发生的出网会把「我们没读过这个文件」洗成「读过」。
     端点失败照记：请求确实发出去了，`llm.log` 里那行的 `ok=false` 就是它的另一半。

  provider / model / token 不在这里重复：那些在 `~/.codebase-tutor/llm.log`（`actor` 列恒 null，
  只留着保 JSONL 列形状），两边靠 `traceId + scene` 关联——同一事实只写一处。
  工具循环 `read_file` 拿到的内容也不在这里记：它已有 `file_read` 那一行（内容在下一轮出门，
  报表按「同一 traceId 内的 file_read 也算出网」口径合并）。
  */

/** 出网形态：按装配路径分档，报表据此区分「整文件」与「窗口摘录」。 */
export type EgressKind =
  /** L1 文件摘要用的结构切片：文件行数、符号名与参数、依赖方向（`l1-slice.ts`），不是整份正文，
      但照样泄露仓内的命名与结构，且全仓每个文件一条，所以逐文件记入审计。 */
  | "l1-slice"
  /** 锚点附近的真实源码摘录（教学 / 宏观设计 / 练习答疑共用 source/excerpt.ts 那套取码规则） */
  | "anchor-excerpt"
  /** 历史：流程生成读的入口文件与推断边窗口；随流程视图退役后不再产生新行。 */
  | "flow-window"
  /** 出题与题面润色用的源码摘录 */
  | "exercise-excerpt"
  /**
    沙箱跑出来的东西出门：学习者写的代码 + stdout/stderr 摘要，随「按需讲评」一起进模型。
    它不是仓库源码，但是模型输出与用户输入的混合物，而且运行输出里完全可能出现学习者粘进去的密钥，
    所以出网记录上单列一档，不能混进 anchor-excerpt。
    */
  | "sandbox-output";

export interface EgressSource {
  kind: EgressKind;
  /** 仓内相对路径（与 `file_read` 的 `path` 同口径） */
  path: string;
  /** 实际发出去的行区间（含端点） */
  from: number;
  to: number;
  /** 真正进请求的那段文本：只用来算 `chars` 与 `hash`，本身不落盘 */
  text: string;
  /** 隐去了几处疑似密钥；`0` 与缺字段是两个读数（判据见 `recordEgress`） */
  masked?: number;
  /** 被我们自己的字符/行上限切短了（读到的不止这些行） */
  truncated?: boolean;
}

/** 装配侧往这个数组里推 `{kind,path,from,to,text}`，发出去之前交 `recordEgress` 一次性计入审计。 */
export type EgressCollector = EgressSource[];

/**
  计入审计：一次装配调一趟，写 N 行（N = 出网的源码段数）。
  `repositoryId` 由路径推导（与导入时写入索引的同一套 `repo_${hash(realpath)}`），装配侧不必把 id 传下来。

  `sent` 是待发的那份完整文本：给了就只登记其中确实还存在的那些段——外层上下文预算会把尾部整段裁掉，
  那一段其实没出门，不登记（判据同文件头第 2 条：报了没发生的出网，比漏报更糟）。
  */
export function recordEgress(input: { repositoryPath: string; scene: string; sessionId?: string; sources: EgressSource[]; sent?: string }): void {
  const sent = input.sent;
  const sources = sent === undefined
    ? input.sources
    // 空 text 不算一段（装配侧可能的确登记过零长窗口），也别让它靠 `includes("")` 恒真混进去
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
      // `masked: 0` 必须照样写下去：「扫过、零命中」和「这道路没扫」是两个读数，
      // 压成同一个默认值，报表就会把没扫过的说成干净的（虚报比漏报糟）。
      ...(source.masked === undefined ? {} : { masked: source.masked }),
      ...(source.truncated ? { truncated: true } : {})
    }, input.sessionId);
  }
}
