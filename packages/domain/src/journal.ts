/** 学习日志事件类型：引擎侧写 `ENGINE_JOURNAL_EVENTS`，界面侧经 `POST /api/repositories/:id/journal` 写 `UI_JOURNAL_EVENTS`，每个类型正好归一边。 */
export type JournalEventType =
  // 引擎侧
  /** 判分结果与风格切换。 */
  | "exercise_result"
  /** 练习未送达：payload 必带 `family`(comprehension|code|llm) 与 `stage`；没带 family 的历史行按「未标族别」单列。 */
  | "exercise_declined"
  /** 出题被用户取消：payload = scene / reason(user_cancel) / waited_ms，带 tag 时一并记。 */
  | "exercise_aborted"
  /** 练习送达：payload.source = llm|cache|rule|review，另带 title。 */
  | "exercise_generated"
  /** 参考模式采纳的锚点：path / line / end_line / why。 */
  | "exercise_anchor"
  /** 出题一趟每次模型调用一条：attempt / step_id / round / finish_reason，正文带 reply(≤2000 字)，仅工具调用带 detail，*_truncated 标截断；不进判分与缓存键。 */
  | "exercise_model_reply"
  | "token_usage"
  | "file_read"
  | "code_search"
  /** 外部 MCP 工具调用，失败也记：server / tool / args_chars / args_hash / result_chars / masked / ok / ms / error(unknown_tool|bad_arguments|timeout|no_tool|server_reported_error)。参数正文不落盘；本行不是源码出网证据，不进 `code_egress` 总数。 */
  | "mcp_call"
  /** 技能正文取用：skill / chars / found。 */
  | "skill_read"
  /** 回合文本落盘：scene(teach|map_chat|practice_chat) + question/answer 双边原文，各截 2000 字带 *_truncated；永久追加、无 TTL。 */
  | "turn_text"
  /** 运行期不变量复检，一回合一条、合格也记：scene + applicable + failed + evidence；判据与离线 `eval:quality` 共用同一函数。 */
  | "turn_invariant"
  /** 回合内向用户提问的结局，一回合最多一条：scene + facet(goal|range|null) + outcome(asked|refused|claimed|discarded) + options + tool_call_id + reason。 */
  | "turn_asked"
  /** 会话线程生命周期：payload = scope(teach|map|practice) + thread_id + scope_ref/exercise_id + reason；session_deleted 只记软删事实，不删既有事件行。 */
  | "session_created"
  | "session_deleted"
  /** agent 回合工具循环摘要，一回合一条：工具轮次与各类调用次数；practice 对话无工具循环不记。 */
  | "loop_round"
  /** 上下文装配摘要，一回合一条：scene + conversation_folded + conversation_recalled + 可选 resumed_from_round / stopped_by(budget|rounds|reads)。 */
  | "turn_context"
  /** 回合被用户主动停止：scene + turn_id + aborted_by(user_stop)；中止回合不写 turn_text。客户端断开不记本事件。 */
  | "turn_aborted"
  /** 沙箱运行一次一条、成败都记：language / stage(validate-proposal|grade) / ok / exit_code / signal / timed_out / truncated / stdout_bytes / duration_ms / isolation(enforced|unavailable) / runner；只记读数不记正文。 */
  | "exercise_run"
  // UI 侧
  | "flow_node_selected"
  | "file_anchored"
  | "file_opened"
  | "line_located"
  | "module_switched"
  | "exercise_submitted"
  | "repository_switched"
  /** 源码出网清单，一行 = 一段进过模型请求的仓内源码：只记指针与指纹(scene/kind/path/lines/chars/hash + masked/truncated)，不记正文；字段语义以 engine `security/egress-log.ts` 为准。 */
  | "code_egress"
  /** 图被建出：diagram + name + source(agent|me) + nodes + edges + downgraded；图内容在 `diagram` 表。 */
  | "diagram_created"
  /** 结构改动落盘：diagram + action(add_node|remove_node|add_edge|remove_edge|add_group|remove_group|relabel|move) + nodes + edges + downgraded + via(agent|user)；几何拖动不记。 */
  | "diagram_edited"
  /** 图改名：diagram + from + to。 */
  | "diagram_renamed"
  /** 图被删：diagram + name + versions。 */
  | "diagram_deleted"
  /** 恢复到某版：diagram + to + note；恢复本身又追加一版。 */
  | "diagram_restored";

/** 写入权分表：引擎事件由引擎写，界面接口只认 `UI_JOURNAL_EVENTS`——`file_read`/`code_egress`/`token_usage` 是审计证据，不能让被审计方填账。 */
export const ENGINE_JOURNAL_EVENTS = [
  "exercise_result",
  "exercise_declined", "exercise_aborted", "exercise_generated", "exercise_anchor", "exercise_model_reply", "token_usage", "file_read", "code_search",
  "mcp_call", "skill_read",
  "turn_text", "turn_invariant", "turn_asked", "loop_round", "turn_context", "turn_aborted", "exercise_run",
  "session_created", "session_deleted", "code_egress",
  "diagram_created", "diagram_edited", "diagram_renamed", "diagram_deleted", "diagram_restored"
] as const satisfies readonly JournalEventType[];

export const UI_JOURNAL_EVENTS = [
  "flow_node_selected", "file_anchored", "file_opened", "line_located", "module_switched",
  "exercise_submitted", "repository_switched"
] as const satisfies readonly JournalEventType[];

export type EngineJournalEventType = (typeof ENGINE_JOURNAL_EVENTS)[number];
export type UiJournalEventType = (typeof UI_JOURNAL_EVENTS)[number];

/** 参数不是 never 就在编译期报错。 */
type AssertNever<T extends never> = T;

/** 编译期对账：两张表并起来必须正好等于 `JournalEventType`。 */
type _JournalPartitionGuard = AssertNever<Exclude<JournalEventType, EngineJournalEventType | UiJournalEventType>>;

/** `Journal.append` 的运行时白名单；只限制新写入，历史事件仍可读。 */
const eventTypes = new Set<JournalEventType>([...ENGINE_JOURNAL_EVENTS, ...UI_JOURNAL_EVENTS]);

export function isJournalEventType(value: unknown): value is JournalEventType {
  return typeof value === "string" && (eventTypes as ReadonlySet<string>).has(value);
}

const uiEventTypes = new Set<string>(UI_JOURNAL_EVENTS);

export function isUiJournalEventType(value: unknown): value is JournalEventType {
  return typeof value === "string" && uiEventTypes.has(value);
}

/** 只为把拒绝理由说准：未知类型与越权类型是两件事。 */
export function isEngineOwnedEventType(value: unknown): boolean {
  return typeof value === "string" && (ENGINE_JOURNAL_EVENTS as readonly string[]).includes(value);
}

export interface JournalEvent {
  id: string;
  type: JournalEventType;
  at: string;
  repositoryId: string;
  sessionId?: string;
  /** 产生该事件的请求 traceId；后台任务无请求上下文时为 null。 */
  traceId?: string | null;
  payload: Record<string, string | number | boolean | null>;
}

/** 回合文本单边落盘上限：与 `POST .../journal` 的 payload 字符串校验同口径，两处一起改。 */
export const TURN_TEXT_LIMIT = 2_000;

/** question/answer 双边原文各截 TURN_TEXT_LIMIT，截断留痕（`*_truncated`）。 */
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