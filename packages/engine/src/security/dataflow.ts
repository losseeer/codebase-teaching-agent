import { hash, repositoryId as deriveRepositoryId } from "../lib.js";
import { Journal } from "../store/journal.js";

/**
  源码出境清单（企业化第 3 条）：**哪些仓内代码片段、以什么形态、进了哪一次模型请求**。

  两条设计口径，都是被这个产品的约束逼出来的：

  1. **记指针与指纹，不记正文**。审计要回答的是「这段代码出过门没有、是哪一版」，
     而不是把源码再抄一份进另一条日志线——那等于自己新开一个泄露面（`.tutor/` 随仓可删、可带走，
     正文进去就再也拿不出来了）。有了 `chars + hash`，事后在本地把同一次装配重跑一遍比哈希，
     就能逐字确认「出去的就是这份」；这也和 §43 那条纪律一致：原文不进任何日志。
  2. **一行 = 一段源码，只在真的发出时写**。埋点都贴着 `provider.complete` 的那一侧，
     缓存命中、预算降级、本地兜底这些**没发出去**的分支一行都不记——
     报了没发生的出境，比漏报更糟（它会把「我们没读过这个文件」洗成「读过」）。
     端点失败照记：请求确实发出去了，`llm.log` 里那行的 `ok=false` 就是它的另一半。

  provider / model / token / 调用方 `actor` 都**不在这里重复**：那些在 `~/.codebase-tutor/llm.log`，
  两边靠 `traceId + scene` 关联（同一事实只写一处，与 engine.jsonl↔llm.log 同一套分工）。
  工具循环 `read_file` 拿到的内容也不在这里记——它已有 `file_read` 那一行（内容在下一轮出门，
  报表按「同一 traceId 内的 file_read 也算出境」口径合并）。
  */

/** 出境形态：按装配路径分档，报表据此区分「整文件」与「窗口摘录」。 */
export type EgressKind =
  /** L1 文件摘要用的**结构切片**：文件行数、符号名与参数、依赖方向（`slice.ts`），不是整份正文——
      但它照样泄露仓内的命名与结构，量也最大（全仓每个文件一条），所以逐文件入账。 */
  | "l1-slice"
  /** 锚点附近的真实源码摘录（教学 / 宏观设计 / 练习答疑共用 source/excerpt.ts 那套取码规则） */
  | "anchor-excerpt"
  /** 流程层读的入口文件与推断边窗口（flows 自己调 executeReadFile，不经工具循环，所以必须单独记） */
  | "flow-window"
  /** 出题与题面润色用的源码摘录 */
  | "exercise-excerpt"
  /**
    沙箱跑出来的东西出门（2026-10-14 刀 1 建类型、刀 4 才真用）：学习者写的代码 + stdout/stderr 摘要，
    随「按需讲评」一起进模型。它不是仓库源码，但**是模型输出与用户输入的混合物**，
    而且运行输出里完全可能出现学习者粘进去的密钥——出境账上必须单列一档，不能混进 anchor-excerpt。
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
  /** 隐去了几处疑似密钥（§43 那两道入口/出口筛）。`0`（扫过、零命中）与不填（没记这个数）是两个读数，不可混写——见 `recordEgress` 的落账注释 */
  masked?: number;
  /** 被我们自己的字符/行上限切短了（读到的不止这些行） */
  truncated?: boolean;
}

/** 装配侧往这个数组里推 `{kind,path,from,to,text}`，发出去之前交 `recordEgress` 一次性落账。 */
export type EgressCollector = EgressSource[];

/**
  落账：一次装配调一趟，写 N 行（N = 出境的源码段数）。
  `repositoryId` 由路径推导（与导入时写入索引的同一套 `repo_${hash(realpath)}`），
  所以装配侧不必把 id 一路传下来——少一条参数就少一处会漏同步的地方。

  `sent` 是待发的那份完整文本。**给了就只登记其中确实还存在的那些段**：
  外层上下文预算（教学 9,000 字、宏观设计/练习各自的上限）会把尾部整段裁掉，那一段其实没出门——
  不登记（判据同文件头第 2 条：报了没发生的出境，比漏报更糟）。
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
      // `masked: 0` 必须照样写下去：**「扫过、零命中」和「这道路压根没扫」是两个读数**，
      // 把它们压成同一个缺省值，报表就会把没扫过的说成干净的（§45：虚报比漏报糟）。
      ...(source.masked === undefined ? {} : { masked: source.masked }),
      ...(source.truncated ? { truncated: true } : {})
    }, input.sessionId);
  }
}
