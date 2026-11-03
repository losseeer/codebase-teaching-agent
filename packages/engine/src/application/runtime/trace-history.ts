import type { AgentScope, AgentTracePayload, TraceHistory, TraceHistoryRun } from "@codebase-tutor/contract";
import { TURN_TEXT_LIMIT, type JournalEvent } from "@codebase-tutor/domain";

/** journal 回合历史：按 traceId 汇总出审计线能还原的步骤；不发模型、不改任何文件。 */

const SCENE_MAP: Record<string, string> = {
  teach: "teaching.turn",
  map_chat: "map.chat",
  practice_chat: "practice.chat",
  exercise_generate: "practice.generate",
  exercise_generate_code: "practice.generate",
  exercise_llm_generate: "practice.generate"
};

/** 历史接口的工作区过滤。 */
const SCOPE_SCENES: Record<AgentScope, readonly string[]> = {
  teaching: ["teaching.turn"],
  map: ["map.chat"],
  practice: ["practice.chat", "practice.generate"]
};

/** 出题没有回合文本，靠这三类事件认成一次运行。 */
const GENERATION_EVENTS = new Set(["exercise_generated", "exercise_declined", "exercise_aborted"]);

type HistoryStep = Omit<AgentTracePayload, "repositoryId" | "runId" | "scene" | "at" | "seq">;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 审计行可能在整趟结束后才落盘；有发生时刻就按它还原每一步。 */
function occurredAt(event: JournalEvent): string {
  const value = event.payload.occurred_at;
  return typeof value === "string" && value ? value : event.at;
}

function sceneOf(events: readonly JournalEvent[]): string | undefined {
  for (const event of events) {
    const scene = event.payload.scene;
    if (typeof scene === "string" && SCENE_MAP[scene]) return SCENE_MAP[scene];
  }
  return events.some((event) => GENERATION_EVENTS.has(event.type)) ? "practice.generate" : undefined;
}

function isTurnEvent(event: JournalEvent): boolean {
  if (GENERATION_EVENTS.has(event.type)) return true;
  if (event.type === "turn_text" || event.type === "turn_aborted") return true;
  if (event.type === "loop_round" || event.type === "turn_context" || event.type === "token_usage") {
    return typeof event.payload.scene === "string" && Boolean(SCENE_MAP[event.payload.scene]);
  }
  return false;
}

function toolStep(event: JournalEvent): HistoryStep | undefined {
  const p = event.payload;
  switch (event.type) {
    case "file_read": {
      const path = clip(text(p.path, 200), 200);
      const denied = p.denied === true;
      const error = text(p.error, 120);
      const masked = num(p.masked) ?? 0;
      const parts = [denied ? "拒绝读取" : error || "已读取"];
      if (p.truncated === true) parts.push("截断");
      if (masked > 0) parts.push("已隐去敏感内容");
      return { kind: "tool", status: denied || error ? "error" : "ok", stepId: event.id, tool: "read_file", label: `读取 ${text(path, 120)}`.trim(), detail: parts.join(" · ") };
    }
    case "code_search": {
      const query = clip(text(p.query, 200), 120);
      const top = text(p.top_paths, 160);
      return { kind: "tool", status: "ok", stepId: event.id, tool: "search_code", label: `检索 ${query}`.trim(), detail: top || (num(p.hits) ? "有命中" : "无命中") };
    }
    case "skill_read": {
      const skill = clip(text(p.skill, 120), 120);
      const found = p.found === true;
      return { kind: "tool", status: found ? "ok" : "error", stepId: event.id, tool: "read_skill", label: `加载技能 ${skill}`.trim(), detail: found ? "已加载" : "未找到" };
    }
    case "mcp_call": {
      const server = text(p.server, 40);
      const tool = text(p.tool, 80);
      const name = server && tool ? `mcp__${server}__${tool}` : tool;
      const ok = p.ok === true;
      const masked = num(p.masked) ?? 0;
      const ms = num(p.ms);
      const parts = [ok ? "已返回" : "失败"];
      if (masked > 0) parts.push("已隐去敏感内容");
      return {
        kind: "tool", status: ok ? "ok" : "error", stepId: event.id, tool: name || "mcp__unknown", label: `调用 ${name || "外部工具"}`.trim(),
        detail: parts.join(" · "),
        ...(ms !== undefined ? { ms } : {})
      };
    }
    case "turn_asked": {
      const outcome = text(p.outcome, 20);
      if (outcome !== "asked" && outcome !== "refused") return undefined;
      const options = text(p.options, 160);
      const reason = text(p.reason, 160);
      return { kind: "tool", status: outcome === "asked" ? "ok" : "error", stepId: event.id, tool: "ask_user", label: outcome === "asked" ? "向你提问" : "提问被挡", detail: outcome === "asked" ? (options || "已提问") : (reason || "被挡") };
    }
    case "diagram_created": {
      if (p.source !== "agent") return undefined;
      return { kind: "tool", status: "ok", stepId: event.id, tool: "set_diagram", label: "修改架构图", detail: "新建" };
    }
    case "diagram_edited": {
      if (p.via !== "agent") return undefined;
      return { kind: "tool", status: "ok", stepId: event.id, tool: "set_diagram", label: "修改架构图", detail: text(p.action, 40) || "修改" };
    }
    default:
      return undefined;
  }
}

function buildRun(runId: string, events: JournalEvent[], repositoryId: string): TraceHistoryRun | undefined {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const scene = sceneOf(ordered);
  if (!scene || !ordered.some(isTurnEvent)) return undefined;
  const generation = scene === "practice.generate";
  const generated = ordered.find((event) => event.type === "exercise_generated");
  const declined = ordered.find((event) => event.type === "exercise_declined");
  const canceled = ordered.find((event) => event.type === "exercise_aborted");
  const turnText = ordered.find((event) => event.type === "turn_text");
  const loop = [...ordered].reverse().find((event) => event.type === "loop_round");
  const usage = [...ordered].reverse().find((event) => event.type === "token_usage");
  const invariant = ordered.find((event) => event.type === "turn_invariant" && Boolean(event.payload.failed));
  const stopped = loop?.payload.stopped_by;
  const limited = stopped === "budget" || stopped === "rounds" || stopped === "reads";
  const aborted = Boolean(canceled) || ordered.some((event) => event.type === "turn_aborted") || loop?.payload.aborted === true || loop?.payload.outcome === "aborted";
  const status: TraceHistoryRun["status"] = aborted ? "aborted" : declined || loop?.payload.outcome === "failed" ? "error" : limited ? "limited" : "ok";
  const threadId = ordered.find((event) => event.sessionId)?.sessionId;
  const inputTokens = num(usage?.payload.input_tokens);
  const outputTokens = num(usage?.payload.output_tokens);
  const provider = typeof usage?.payload.provider === "string" ? usage.payload.provider : undefined;
  const reads = num(loop?.payload.tool_reads) ?? ordered.filter((event) => event.type === "file_read").length;
  const searches = num(loop?.payload.tool_searches) ?? ordered.filter((event) => event.type === "code_search").length;
  const skills = num(loop?.payload.tool_skills) ?? ordered.filter((event) => event.type === "skill_read").length;
  const external = num(loop?.payload.tool_external) ?? ordered.filter((event) => event.type === "mcp_call").length;
  const rounds = num(loop?.payload.tool_rounds);
  const question = clip(text(turnText?.payload.question, 2_000), 400);
  const answer = text(turnText?.payload.answer, TURN_TEXT_LIMIT);
  // 对话回合只有最终答复；出题按每次模型调用各回放一条，中间回合也看得到
  const replayed: { reply?: string; detail?: string; finishReason?: string; ms?: number; at: string }[] = answer
    ? [{ reply: `${answer}${turnText?.payload.answer_truncated === true ? "…" : ""}`, at: turnText?.at ?? ordered[0].at }]
    : ordered
        .filter((event) => event.type === "exercise_model_reply")
        .map((event) => {
          const reply = text(event.payload.reply, TURN_TEXT_LIMIT);
          const detail = text(event.payload.detail, 600);
          const finishReason = typeof event.payload.finish_reason === "string" ? event.payload.finish_reason : undefined;
          const attempt = num(event.payload.attempt);
          const ms = num(event.payload.ms);
          // 自证失败会重出一版；两条最终回复都留在轨迹里，标清首轮/修复
          const note = finishReason === "stop" && attempt !== undefined ? (attempt > 1 ? "修复重出" : "首轮出题") : "";
          const shownDetail = detail ? `${detail}${event.payload.detail_truncated === true ? "…" : ""}` : note;
          return {
            ...(reply ? { reply: `${reply}${event.payload.reply_truncated === true ? "…" : ""}` } : {}),
            ...(shownDetail ? { detail: shownDetail } : {}),
            ...(finishReason ? { finishReason } : {}),
            ...(ms !== undefined ? { ms } : {}),
            at: event.at
          };
        })
        .filter((item) => item.reply || item.detail);
  // token 是整趟的合计；只有一条模型回合时才挂在它上面，多条时不冒充单次读数
  const showTokens = replayed.length <= 1;

  const parts: string[] = [];
  if (generation) parts.push(canceled ? "已取消出题" : generated ? "已出题" : declined ? "未出题" : "出题");
  if (rounds) parts.push(`${rounds} 轮工具`);
  if (reads) parts.push(`读 ${reads} 个文件`);
  if (searches) parts.push(`检索 ${searches} 次`);
  if (skills) parts.push(`技能 ${skills} 份`);
  if (external) parts.push(`外部 ${external} 次`);
  if (inputTokens !== undefined || outputTokens !== undefined) parts.push(`输入 ${inputTokens ?? 0} / 输出 ${outputTokens ?? 0}`);
  if (stopped === "budget") parts.push("预算到线");
  else if (stopped === "rounds") parts.push("轮次用完");
  else if (stopped === "reads") parts.push("读取额度用完");
  if (invariant) parts.push("复检失守");

  const steps: AgentTracePayload[] = [];
  let seq = 0;
  const push = (step: HistoryStep & { at: string }): void => {
    steps.push({ repositoryId, runId, scene, seq: seq++, ...step });
  };
  const declineReason = declined ? text(declined.payload.reason, 400) : "";
  push({
    kind: "turn",
    status,
    stepId: "journal-input",
    label: question ? text(question, 80) : generation ? "出题" : "开始处理",
    ...(question || declineReason ? { detail: question || declineReason } : {}),
    ...(provider ? { model: provider } : {}),
    at: ordered[0].at
  });
  const modelSteps = replayed.length ? replayed : usage ? [{ at: usage.at }] : [];
  modelSteps.forEach((item, index) => {
    push({
      kind: "model",
      status: "ok",
      stepId: replayed.length ? `journal-model-${index + 1}` : "journal-model",
      label: item.reply ? "模型回复" : item.detail ? "调用工具" : "模型回复",
      ...(item.reply ? { reply: item.reply } : {}),
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.finishReason ? { finishReason: item.finishReason } : {}),
      ...(item.ms !== undefined ? { ms: item.ms } : {}),
      ...(provider ? { model: provider } : {}),
      ...(showTokens && inputTokens !== undefined ? { inputTokens } : {}),
      ...(showTokens && outputTokens !== undefined ? { outputTokens } : {}),
      at: item.at
    });
  });
  for (const event of ordered) {
    const step = toolStep(event);
    if (step) push({ ...step, at: occurredAt(event) });
  }

  return {
    runId,
    scene,
    ...(threadId ? { threadId } : {}),
    ...(generated && typeof generated.payload.title === "string" && generated.payload.title.trim() ? { title: generated.payload.title.trim() } : {}),
    status,
    startedAt: ordered[0].at,
    endedAt: ordered[ordered.length - 1].at,
    ...(parts.length ? { summary: parts.join(" · ") } : {}),
    steps
  };
}

export function buildTraceHistory(events: readonly JournalEvent[], repositoryId: string, limit: number, threadId?: string, scope?: AgentScope): TraceHistory {
  const groups = new Map<string, JournalEvent[]>();
  for (const event of events) {
    if (!event.traceId) continue;
    if (threadId && event.sessionId !== threadId) continue;
    const list = groups.get(event.traceId);
    if (list) list.push(event);
    else groups.set(event.traceId, [event]);
  }
  const allowed = scope ? SCOPE_SCENES[scope] : undefined;
  const runs: TraceHistoryRun[] = [];
  for (const [runId, list] of groups) {
    const run = buildRun(runId, list, repositoryId);
    if (run && (!allowed || allowed.includes(run.scene))) runs.push(run);
  }
  return { runs: runs.sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt)).slice(0, Math.max(0, limit)) };
}
