/**
  学习日志的事件类型。引擎侧写 `ENGINE_JOURNAL_EVENTS`，界面侧经 `POST /api/repositories/:id/journal` 写 `UI_JOURNAL_EVENTS`。
  每个类型必须正好归入一边；运行时白名单由这两张表派生。
*/
export type JournalEventType =
  // 引擎侧
  /** 判分结果与风格切换。 */
  | "exercise_result"
  /**
    练习未送达事件。payload 必带 `family`（comprehension|code|llm）与 `stage`：
    `no_target` 这一档是共用的选题路径写出的，两族都可能命中，没有族别就没法把「代码题被沙箱拒了」
    和「这个仓里挑不出单元」分在一个数里读。没带这个键的历史行按「未标族别」单列。
  */
  | "exercise_declined"
  /** 练习送达事件（转化率的分母）：payload.source = llm|cache|rule|review；拒绝侧另有 exercise_declined。 */
  | "exercise_generated"
  | "token_usage"
  | "file_read"
  | "code_search"
  /**
    产品 agent 调了一次外部 MCP 工具。一次调用一条，失败也记——
    分母要完整：连不上、超时、参数不合法、server 自己报错是四种不同处置（改配置 / 调上限 / 换提示词 / 收白名单）。
    payload = `server` / `tool` / `args_chars` + `args_hash`（参数正文不落盘，与 `code_egress` 同一口径：
    发出去的可能是仓内代码，另开一条日志线等于自己造一个泄露面）/ `result_chars` / `masked`（密钥筛隐去处数，
    `0` 与不填是两个读数）/ `ok` / `ms` / `error`(unknown_tool|bad_arguments|timeout|no_tool|server_reported_error)。
    这一行不能当「源码出网」的证据：MCP server 是别人写的本机子进程，它拿到的内容会不会再往外走，引擎不知道，
    所以这条线只是「我们把什么交给了哪个 server」的指针。数据流报表要单列，不许混进 `code_egress` 的总数。
  */
  | "mcp_call"
  /**
    产品 agent 取了一份技能正文：`skill` + `chars` + `found`。
    记「取过」而不是只记「装过」——一份写好的做法没人调用，是这份做法没被模型认出来的读数，
    而清单里有名字、正文从没被取走这件事只能从这一行看出来。
  */
  | "skill_read"
  /** 回合文本落盘：payload = scene(teach|map_chat|practice_chat) + question/answer
      双边原文，各截 2000 字并带 *_truncated 留痕；永久追加、不做 TTL、无开关。教学法机检与表达质量裁判的被测输入源。 */
  | "turn_text"
  /** 运行期不变量复检：一回合一条，合格也记（分母要运行时成立）。
      payload = scene(teach|map_chat|practice_chat) + applicable(该回合该判的条目) + failed(失守条目) + evidence(逐条证据摘录)。
      判据与离线 `phaseB:eval` 共用同一个函数，所以「线上说合格、离线算不合格」不可能出现。 */
  | "turn_invariant"
  /** 回合内向用户提问的四种结局，一回合最多一条（挡下的尝试也记）。
      payload = scene + facet(goal|range|null) + outcome(asked|refused|claimed|discarded) + options(候选短标签，斜杠分隔) + tool_call_id(认领的那条调用) + reason。
      outcome=refused 的 reason 是那句挡下它的判据；discarded 的 reason 是 expired / new_question / claim_missed（换模型或点了第二次）。
      提问占比与「问完用户到底答没答」的转化率都从这一行算。 */
  | "turn_asked"
  /** 会话线程的生命周期事件：`session_created` 在引擎发 id 建线程时写，
      `session_deleted` 只在软删时写。payload = scope(teach|map|practice) + thread_id + scope_ref/exercise_id + reason。
      删除是产品线的动作，journal 这条线只留「发生过删除」这一事实，不删任何既有事件行。 */
  | "session_created"
  | "session_deleted"
  /** agent 回合的工具循环摘要：一回合一条，记工具轮次与各类工具调用次数。
      practice 对话无工具循环，不记本事件。 */
  | "loop_round"
  /** 回合的上下文装配摘要：一回合一条，三作用域都有（practice 没有工具轮，也有这一行）。
      payload = scene + conversation_folded（本轮折掉几条历史）+ conversation_recalled（按词法找回几条）
      + 可选 resumed_from_round（从第几轮检查点续上）与 stopped_by（budget = 预算到线 / rounds = 工具轮次用完 / reads = 读文件额度用完）。
      与 `loop_round` 分家：那边记「工具做了几次」，这边记「这条回复是在多大的上下文里写的」。 */
  | "turn_context"
  /** 回合被用户主动停止：payload = scene(teach|map_chat|practice_chat) + turn_id +
      aborted_by(恒为 user_stop)。与「客户端断开」刻意区分——后者引擎照常算完落库，不记本事件。
      中止的一轮没有成品：不写 turn_text，也不伪造 assistant 正文。 */
  | "turn_aborted"
  /**
    沙箱真跑了一次代码。一次运行一条，成败都记——
    分母要完整：出题自证链跑三趟（原码/缺陷版/参考解），判分再跑一趟，少一条就分不清「题没出成」和「题没被作答」。
    payload：`language` / `stage`(validate-proposal|grade) / `ok` / `exit_code` / `signal` / `timed_out` /
    `truncated` / `stdout_bytes` / `duration_ms` / `isolation`(enforced|unavailable) / `runner`（解释器与 profile 指纹，
    换 runner 要让旧题的缓存键一起失效，所以这列必须落在行上才查得回）。
    只记读数不记正文：学习者写的代码与运行输出留在内存里判完就丢，正文进 `code_egress` 那一侧才有出网记录。
  */
  | "exercise_run"
  // UI 侧
  | "flow_node_selected"
  | "file_anchored"
  | "file_opened"
  | "line_located"
  | "module_switched"
  | "exercise_submitted"
  | "repository_switched"
  /**
    把本仓与地址簿里的另一个仓配对（跨仓 HTTP 接缝）。引擎侧写：这条读的是两个仓的源码，
    配上几条是要能查的数。只有 agent 调 `cross_repo_link` 时才会发生（`via: "tool"`）。
    payload：`other_repository_id` / `outbound` / `inbound`（两个方向各自配上的条数）。
  */
  | "repository_paired"
  /**
    源码出网清单（LLM 数据流审计）。引擎侧写，一行 = 一段进过模型请求的仓内源码。
    记指针与指纹（`scene`/`kind`/`path`/`lines`/`chars`/`hash`，另带 `masked`/`truncated`），不记正文；
    与 llm.log 靠 `traceId + scene` 关联。字段语义以 engine `security/egress-log.ts` 的注释为准，不在此复述。
  */
  | "code_egress"
  /**
    画布上的一张图被建出来（agent 一次画完整张，或用户新建空白）：
    payload = diagram + name + source(agent|me) + nodes + edges + downgraded（几条边被引擎降了档）。
    记的是「谁画的、画了多少、有几条不成立」，不记图内容（内容在 `diagram` 表里）。
  */
  | "diagram_created"
  /**
    一次结构改动落了盘：payload = diagram + action(add_node|remove_node|add_edge|remove_edge|add_group|remove_group|relabel|move)
    + nodes + edges + downgraded + via(agent|user)。
    几何拖动不走这条——位置不承载对错、也不是判断被推翻的读数，一天能拖几百次，写进审计只会淹掉真信号。
  */
  | "diagram_edited"
  /** 图改名（payload = diagram + from + to）。改名不存版本：它不动结构。 */
  | "diagram_renamed"
  /** 图被删（payload = diagram + name + versions）：版本历史一起删，所以这条要留痕。 */
  | "diagram_deleted"
  /** 恢复到某一版（payload = diagram + to + note）：恢复本身又追加一版，历史只追加不改写。 */
  | "diagram_restored";

/**
  同一份事件的写入权分两张表。
  上面那张联合类型说的是「有哪些事件」，这两张说的是「谁有资格写」：
  `POST /api/repositories/:id/journal` 只认 UI 侧那张。理由是证据价值本身——
  `.tutor/journal.jsonl` 承担着「哪些代码出过门」这类账（`file_read` / `code_egress` / `token_usage`），
  而这条接口是本机任何进程都能调的：能塞一行就能编一段账，能编账的审计线就不是审计线。
  引擎侧那张由引擎在工具循环、装配与成本核算里自己写，界面不得发射（同一事实只写一处）。
*/
export const ENGINE_JOURNAL_EVENTS = [
  "exercise_result",
  "exercise_declined", "exercise_generated", "token_usage", "file_read", "code_search",
  "mcp_call", "skill_read",
  "turn_text", "turn_invariant", "turn_asked", "loop_round", "turn_context", "turn_aborted", "exercise_run",
  "session_created", "session_deleted", "repository_paired", "code_egress",
  "diagram_created", "diagram_edited", "diagram_renamed", "diagram_deleted", "diagram_restored"
] as const satisfies readonly JournalEventType[];

export const UI_JOURNAL_EVENTS = [
  "flow_node_selected", "file_anchored", "file_opened", "line_located", "module_switched",
  "exercise_submitted", "repository_switched"
] as const satisfies readonly JournalEventType[];

export type EngineJournalEventType = (typeof ENGINE_JOURNAL_EVENTS)[number];
export type UiJournalEventType = (typeof UI_JOURNAL_EVENTS)[number];

/** 约束到 `never` 的断言别名：参数不是 never 就在编译期报错（下面拿它当对账闸）。 */
type AssertNever<T extends never> = T;

/**
  编译期对账：两张表并起来必须正好等于 `JournalEventType`。
  往 union 加了新事件却忘了归进某一张表，这里直接报错，不用等运行期，也不用靠人审。
*/
type _JournalPartitionGuard = AssertNever<Exclude<JournalEventType, EngineJournalEventType | UiJournalEventType>>;

/**
  `Journal.append` 的白名单，运行时判据（`JournalEventType` 只是编译期类型）。
  两张表并起来是全集，漏归类由上面那条编译期对账当场报错。读侧不校验类型：历史事件仍可读，只限制新写入。
  */
const eventTypes = new Set<JournalEventType>([...ENGINE_JOURNAL_EVENTS, ...UI_JOURNAL_EVENTS]);

/** 允许写进审计线的事件全集判据：`Journal.append` 用它挡未知类型。 */
export function isJournalEventType(value: unknown): value is JournalEventType {
  return typeof value === "string" && (eventTypes as ReadonlySet<string>).has(value);
}

/**
  界面侧可发射的那一半。`POST /api/repositories/:id/journal` 用它而不是上面的全集：
  `file_read` / `code_egress` / `token_usage` 这些引擎侧类型是审计证据，不能让被审计方自己填账。
  引擎自己写走 `Journal.append`（全集合），不受这条限制。
  */
const uiEventTypes = new Set<string>(UI_JOURNAL_EVENTS);

export function isUiJournalEventType(value: unknown): value is JournalEventType {
  return typeof value === "string" && uiEventTypes.has(value);
}

/** 这个类型是不是「引擎专属」——只为把拒绝理由说准（未知类型与越权类型是两件事）。 */
export function isEngineOwnedEventType(value: unknown): boolean {
  return typeof value === "string" && (ENGINE_JOURNAL_EVENTS as readonly string[]).includes(value);
}

export interface JournalEvent {
  id: string;
  type: JournalEventType;
  at: string;
  repositoryId: string;
  sessionId?: string;
  /** 产生该事件的请求 traceId；后台任务（导入 / 监听刷新）无请求上下文时为 null。 */
  traceId?: string | null;
  payload: Record<string, string | number | boolean | null>;
}

/**
  回合文本单边落盘上限：与 `POST .../journal` 的 payload 字符串校验同口径，两处数字必须一起改，
  所以它住在 journal 旁边而不是通用工具模块里。
 */
export const TURN_TEXT_LIMIT = 2_000;

/**
  `turn_text` 事件的 payload 构造：三种对话（teach / map_chat / practice_chat）的问题+回复双边原文进 journal，
  各截 TURN_TEXT_LIMIT；截断必须留痕（`*_truncated`），丢了字要能看出来。
  */
export function turnTextPayload(scene: "teach" | "map_chat" | "practice_chat", question: string, answer: string): Record<string, string | number | boolean> {
  const q = question.slice(0, TURN_TEXT_LIMIT);
  const a = answer.slice(0, TURN_TEXT_LIMIT);
  return {
    scene,
    question: q,
    question_truncated: question.length > q.length,
    answer: a,
    answer_truncated: answer.length > a.length
  };
}
