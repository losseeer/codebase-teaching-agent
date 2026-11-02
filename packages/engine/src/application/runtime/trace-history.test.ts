import { describe, expect, it } from "vitest";
import type { JournalEvent, JournalEventType } from "@codebase-tutor/domain";
import { traceHistorySchema } from "@codebase-tutor/contract";

import { buildTraceHistory } from "./trace-history.js";

let serial = 0;
function ev(type: JournalEventType, traceId: string, at: string, payload: JournalEvent["payload"], sessionId = "thread-1"): JournalEvent {
  serial += 1;
  return { id: `ev-${serial}`, type, at, repositoryId: "repo", sessionId, traceId, payload };
}

describe("journal 回合历史", () => {
  it("按 traceId 汇总一回合：输入、模型汇总、工具读数与摘要", () => {
    const events = [
      ev("turn_asked", "t1", "2026-11-02T03:00:01.000Z", { scene: "map_chat", outcome: "asked", options: "范围 / 目标" }),
      ev("token_usage", "t1", "2026-11-02T03:00:02.000Z", { scene: "map_chat", input_tokens: 100, output_tokens: 20, provider: "model:v1" }),
      ev("turn_text", "t1", "2026-11-02T03:00:03.000Z", { scene: "map_chat", question: "这个模块先看哪里？", answer: "先看 main.ts。" }),
      ev("file_read", "t1", "2026-11-02T03:00:04.000Z", { path: "src/main.ts", lines: 20, truncated: false, denied: false }),
      ev("code_search", "t1", "2026-11-02T03:00:05.000Z", { query: "register", hits: 2, top_paths: "src/a.ts、src/b.ts" }),
      ev("skill_read", "t1", "2026-11-02T03:00:06.000Z", { skill: "tutor-fixture", chars: 1200, found: true }),
      ev("mcp_call", "t1", "2026-11-02T03:00:07.000Z", { server: "fixture", tool: "echo", result_chars: 12, masked: 0, ok: true, ms: 8 }),
      ev("loop_round", "t1", "2026-11-02T03:00:08.000Z", { scene: "map_chat", tool_rounds: 2, tool_reads: 1, tool_searches: 1, tool_skills: 1, tool_external: 1 }),
      ev("turn_context", "t1", "2026-11-02T03:00:09.000Z", { scene: "map_chat", conversation_folded: 0, conversation_recalled: 0 })
    ];
    const history = buildTraceHistory(events, "repo", 10);
    expect(history.runs).toHaveLength(1);
    const parsed = traceHistorySchema.safeParse(history);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    const run = history.runs[0];
    expect(run).toMatchObject({ runId: "t1", scene: "map.chat", threadId: "thread-1", status: "ok" });
    expect(run.summary).toContain("2 轮工具");
    expect(run.summary).toContain("读 1 个文件");
    expect(run.summary).toContain("输入 100 / 输出 20");

    const input = run.steps.find((step) => step.kind === "turn");
    expect(input).toMatchObject({ label: "这个模块先看哪里？", detail: "这个模块先看哪里？", status: "ok", model: "model:v1" });
    const model = run.steps.find((step) => step.kind === "model");
    expect(model).toMatchObject({ inputTokens: 100, outputTokens: 20, model: "model:v1", reply: "先看 main.ts。" });

    const tools = run.steps.filter((step) => step.kind === "tool");
    expect(tools.map((step) => step.tool)).toEqual(["ask_user", "read_file", "search_code", "read_skill", "mcp__fixture__echo"]);
    expect(tools.find((step) => step.tool === "read_file")).toMatchObject({ detail: "已读取", status: "ok" });
    expect(tools.find((step) => step.tool === "read_file")?.label).toContain("src/main.ts");
    expect(tools.find((step) => step.tool === "search_code")).toMatchObject({ label: "检索 register", detail: "src/a.ts、src/b.ts" });
    expect(tools.find((step) => step.tool === "read_skill")).toMatchObject({ label: "加载技能 tutor-fixture", detail: "已加载" });
    expect(tools.find((step) => step.tool === "mcp__fixture__echo")).toMatchObject({ detail: "已返回", ms: 8, status: "ok" });
  });

  it("中止的练习回合没有 turn_text 也能回放：状态、场景与已发生读取", () => {
    const events = [
      ev("skill_read", "t2", "2026-11-02T03:01:01.000Z", { skill: "tutor-fixture", chars: 0, found: false }),
      ev("file_read", "t2", "2026-11-02T03:01:02.000Z", { path: "src/main.ts", lines: 20, truncated: false, denied: false }),
      ev("loop_round", "t2", "2026-11-02T03:01:03.000Z", { scene: "practice_chat", aborted: true, outcome: "aborted", tool_rounds: 1, tool_reads: 1, tool_skills: 1, tool_searches: 0, tool_external: 0 }),
      ev("turn_aborted", "t2", "2026-11-02T03:01:04.000Z", { scene: "practice_chat", turn_id: "turn-2", aborted_by: "user_stop" })
    ];
    const run = buildTraceHistory(events, "repo", 10).runs[0];
    expect(run).toMatchObject({ runId: "t2", scene: "practice.chat", status: "aborted" });
    expect(run.steps.find((step) => step.kind === "turn")?.label).toBe("开始处理");
    expect(run.summary).toContain("读 1 个文件");
    expect(run.summary).toContain("技能 1 份");
    expect(run.steps.find((step) => step.tool === "read_skill")).toMatchObject({ status: "error", detail: "未找到" });
  });

  it("不是回合的 trace 组跳过；limit 只取最近的几条", () => {
    const events = [
      ev("file_opened", "t0", "2026-11-02T03:02:00.000Z", { path: "src/a.ts" }),
      ev("turn_text", "t1", "2026-11-02T03:02:01.000Z", { scene: "teach", question: "问一", answer: "答一" }),
      ev("loop_round", "t1", "2026-11-02T03:02:02.000Z", { scene: "teach", tool_rounds: 0 }),
      ev("turn_text", "t2", "2026-11-02T03:02:03.000Z", { scene: "teach", question: "问二", answer: "答二" }),
      ev("loop_round", "t2", "2026-11-02T03:02:04.000Z", { scene: "teach", tool_rounds: 0 })
    ];
    const history = buildTraceHistory(events, "repo", 1);
    expect(history.runs.map((run) => run.runId)).toEqual(["t2"]);
    expect(history.runs[0].scene).toBe("teaching.turn");
  });

  it("出题按 journal 汇总成一次运行；被拒的那趟标失败", () => {
    const generated = buildTraceHistory([
      ev("file_read", "g1", "2026-11-02T03:05:01.000Z", { path: "src/a.ts", lines: 10, truncated: false, denied: false }),
      ev("token_usage", "g1", "2026-11-02T03:05:02.000Z", { scene: "exercise_generate_code", input_tokens: 30, output_tokens: 10, provider: "model:v1" }),
      ev("exercise_model_reply", "g1", "2026-11-02T03:05:03.000Z", { scene: "practice.generate", reply: "{\"title\":\"模型出的题\"}", reply_truncated: false }),
      ev("exercise_generated", "g1", "2026-11-02T03:05:04.000Z", { family: "code", kind: "patch_edit", source: "llm", target_unit: "unit-1" })
    ], "repo", 10).runs[0];
    expect(generated).toMatchObject({ runId: "g1", scene: "practice.generate", status: "ok" });
    expect(generated.summary).toContain("已出题");
    expect(generated.summary).toContain("输入 30 / 输出 10");
    expect(generated.steps.find((step) => step.kind === "turn")?.label).toBe("出题");
    expect(generated.steps.find((step) => step.kind === "model")?.reply).toContain("模型出的题");
    expect(generated.steps.find((step) => step.tool === "read_file")).toBeDefined();

    const declined = buildTraceHistory([
      ev("exercise_declined", "g2", "2026-11-02T03:06:01.000Z", { family: "llm", stage: "no_theme_hits", reason: "主题「操作系统」在源码里没有命中" })
    ], "repo", 10).runs[0];
    expect(declined).toMatchObject({ runId: "g2", scene: "practice.generate", status: "error" });
    expect(declined.summary).toContain("未出题");
    expect(declined.steps.find((step) => step.kind === "turn")?.detail).toContain("操作系统");
  });

  it("出题的多条模型回复逐条回放，不合并成最后一条", () => {
    const run = buildTraceHistory([
      ev("exercise_model_reply", "g3", "2026-11-02T03:08:01.000Z", { scene: "practice.generate", attempt: 1, step_id: "m1", round: 1, reply: "先检索注册点", reply_truncated: false }),
      ev("token_usage", "g3", "2026-11-02T03:08:02.000Z", { scene: "exercise_llm_generate", input_tokens: 50, output_tokens: 20, provider: "model:v1" }),
      ev("exercise_model_reply", "g3", "2026-11-02T03:08:03.000Z", { scene: "practice.generate", attempt: 1, step_id: "m2", round: 2, reply: "再修一处锚点", reply_truncated: false }),
      ev("exercise_generated", "g3", "2026-11-02T03:08:04.000Z", { family: "llm", source: "llm", target_unit: "unit-1" })
    ], "repo", 10).runs[0];
    const models = run.steps.filter((step) => step.kind === "model");
    expect(models.map((step) => step.reply)).toEqual(["先检索注册点", "再修一处锚点"]);
    expect(models.map((step) => step.stepId)).toEqual(["journal-model-1", "journal-model-2"]);
    expect(models.every((step) => step.inputTokens === undefined && step.outputTokens === undefined)).toBe(true);
    expect(run.summary).toContain("输入 50 / 输出 20");
  });

  it("出题只有工具调用的回合也在历史里留行，并标明调用了什么", () => {
    const run = buildTraceHistory([
      ev("exercise_model_reply", "g4", "2026-11-02T03:09:01.000Z", { scene: "practice.generate", attempt: 1, step_id: "m1", round: 1, detail: "本轮调用 1 个工具\nread_skill {\"name\":\"exercise-code-concepts\"}", detail_truncated: false, finish_reason: "tool_calls" }),
      ev("exercise_model_reply", "g4", "2026-11-02T03:09:02.000Z", { scene: "practice.generate", attempt: 1, step_id: "m2", round: 2, reply: "{\"title\":\"模型出的题\"}", reply_truncated: false, finish_reason: "stop" }),
      ev("exercise_generated", "g4", "2026-11-02T03:09:03.000Z", { family: "llm", source: "llm", target_unit: "unit-1" })
    ], "repo", 10).runs[0];
    const models = run.steps.filter((step) => step.kind === "model");
    expect(models.map((step) => step.label)).toEqual(["调用工具", "模型回复"]);
    expect(models[0]).toMatchObject({ finishReason: "tool_calls" });
    expect(models[0].reply).toBeUndefined();
    expect(models[0].detail).toContain("read_skill");
    expect(models[1].reply).toContain("模型出的题");
  });

  it("出题取消在历史里标提前结束，已发生的模型回合保留", () => {
    const run = buildTraceHistory([
      ev("exercise_model_reply", "g5", "2026-11-02T03:10:01.000Z", { scene: "practice.generate", attempt: 1, step_id: "m1", round: 1, reply: "查到了一半的素材", reply_truncated: false, finish_reason: "stop" }),
      ev("exercise_aborted", "g5", "2026-11-02T03:10:02.000Z", { scene: "practice.generate", reason: "user_cancel", waited_ms: 1200 })
    ], "repo", 10).runs[0];
    expect(run).toMatchObject({ runId: "g5", scene: "practice.generate", status: "aborted" });
    expect(run.summary).toContain("已取消出题");
    expect(run.steps.find((step) => step.kind === "model")?.reply).toContain("查到了一半的素材");
  });

  it("历史按工作区过滤：练习区同时给出题与答疑", () => {
    const events = [
      ev("turn_text", "t1", "2026-11-02T03:07:01.000Z", { scene: "teach", question: "问一", answer: "答一" }),
      ev("turn_text", "t2", "2026-11-02T03:07:02.000Z", { scene: "map_chat", question: "问二", answer: "答二" }),
      ev("turn_text", "t3", "2026-11-02T03:07:03.000Z", { scene: "practice_chat", question: "问三", answer: "答三" }),
      ev("exercise_generated", "g1", "2026-11-02T03:07:04.000Z", { family: "llm", source: "llm", target_unit: "unit-1" })
    ];
    expect(buildTraceHistory(events, "repo", 10, undefined, "teaching").runs.map((run) => run.runId)).toEqual(["t1"]);
    expect(buildTraceHistory(events, "repo", 10, undefined, "map").runs.map((run) => run.runId)).toEqual(["t2"]);
    expect(buildTraceHistory(events, "repo", 10, undefined, "practice").runs.map((run) => run.runId).sort()).toEqual(["g1", "t3"]);
  });

  it("失败回合标 error；线程过滤只取指定 session", () => {
    const events = [
      ev("turn_text", "t1", "2026-11-02T03:03:01.000Z", { scene: "map_chat", question: "问一", answer: "答一" }, "thread-1"),
      ev("loop_round", "t1", "2026-11-02T03:03:02.000Z", { scene: "map_chat", outcome: "failed" }, "thread-1"),
      ev("turn_text", "t3", "2026-11-02T03:03:03.000Z", { scene: "teach", question: "问二", answer: "答二" }, "thread-2"),
      ev("loop_round", "t3", "2026-11-02T03:03:04.000Z", { scene: "teach", tool_rounds: 0 }, "thread-2")
    ];
    const all = buildTraceHistory(events, "repo", 10);
    expect(all.runs.find((run) => run.runId === "t1")?.status).toBe("error");
    const scoped = buildTraceHistory(events, "repo", 10, "thread-2");
    expect(scoped.runs.map((run) => run.runId)).toEqual(["t3"]);
  });

  it("预算到线也算提前结束，不冒充完成", () => {
    const events = [
      ev("turn_text", "t4", "2026-11-02T03:04:01.000Z", { scene: "map_chat", question: "问三", answer: "答三" }),
      ev("loop_round", "t4", "2026-11-02T03:04:02.000Z", { scene: "map_chat", tool_rounds: 3, tool_reads: 1, stopped_by: "budget" })
    ];
    const run = buildTraceHistory(events, "repo", 10).runs[0];
    expect(run.status).toBe("aborted");
    expect(run.summary).toContain("预算到线");
  });
});
