import { readJournal } from "../store/journal.js";
import type { JournalEvent } from "@codebase-tutor/shared";

/**
  只读聚合脚本：按 traceId 把 journal.jsonl 的事件串成「一次请求 = 一段可读轨迹」。
  journal 是 append-only 事件流，逐行看是散的；复盘某次对话的完整执行轨迹
  （用户问了什么 → 模型提议/守门裁决 → 读了哪些文件 → 回了什么）要靠 traceId 分组重放。

  用法：pnpm run-trace -- <被学习仓路径> [--last 20] [--trace <traceId>] [--json]
  - 不带 --trace 时按时间倒序列出最近 N 次请求（traceId 为 null 的后台事件归入「后台」组）；
  - --json 输出分组后的原始事件，供进一步机检。

  口径纪律与 metrics.ts 一致：缺字段落「未记」，不用默认值伪装；本脚本纯只读，不写任何文件。
*/

function clip(value: unknown, max = 80): string {
  if (value === null || value === undefined) return "—";
  const text = String(value).replaceAll(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function eventLine(event: JournalEvent): string {
  const p = event.payload;
  switch (event.type) {
    case "turn_text":
      return `问「${clip(p.question, 60)}」答「${clip(p.answer, 80)}」${p.answer_truncated ? "（答截断）" : ""}${p.question_truncated ? "（问截断）" : ""}`;
    case "loop_round":
      return `决策=${p.decision ?? "未记"} 提议=${p.proposed ?? "—"}→执行=${p.executed ?? "—"} 工具轮=${p.tool_rounds ?? "未记"} 读=${p.tool_reads ?? "未记"} 搜=${p.tool_searches ?? "未记"}`;
    case "token_usage":
      return `in=${p.input_tokens ?? "未记"} out=${p.output_tokens ?? "未记"} cache=${p.cache_hit_tokens ?? 0} provider=${p.provider ?? "未记"} scene=${p.scene ?? "未记"}${p.mode === "degraded" ? " 【降级】" : ""}`;
    case "file_read":
      return `${p.path ?? "未记"}${p.denied ? " 【拒绝】" : ""}${p.error ? ` 【错误:${clip(p.error, 40)}】` : ""}${p.truncated ? " 【截断】" : ""}`;
    case "code_search":
      return `搜「${clip(p.query, 60)}」命中=${p.hits ?? "未记"} 前几落点：${clip(p.top_paths, 60)}`;
    case "action_veto":
      return `提议=${p.proposed ?? "未记"} 被守门否决，强制=${p.enforced ?? "未记"}`;
    case "hint_depth":
      return `深度=${p.depth ?? "未记"} stage=${p.stage ?? "未记"}（unit=${clip(p.unit_id, 24)}）`;
    case "scope_degraded":
      return `node=${clip(p.node_id, 40)} scopePaths=${p.scope_paths ?? "未记"}`;
    default: {
      const detail = Object.entries(p).slice(0, 5).map(([key, value]) => `${key}=${clip(value, 30)}`).join(" ");
      return detail || "（无字段）";
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const repoPath = args.find((arg) => !arg.startsWith("--"));
  if (!repoPath) {
    console.error("用法：tsx src/scripts/run-trace.ts <被学习仓路径> [--last 20] [--trace <traceId>] [--json]");
    process.exit(2);
  }
  const lastFlag = args.indexOf("--last");
  const last = lastFlag >= 0 ? Number(args[lastFlag + 1]) || 20 : 20;
  const traceFlag = args.indexOf("--trace");
  const traceId = traceFlag >= 0 ? args[traceFlag + 1] : undefined;
  const asJson = args.includes("--json");

  const events = readJournal(repoPath);
  if (!events.length) {
    console.log(`（${repoPath}/.tutor/journal.jsonl 为空或不存在——该仓还没有任何教学/对话事件。）`);
    return;
  }

  const groups = new Map<string, JournalEvent[]>();
  for (const event of events) {
    const key = event.traceId ?? "background";
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }
  const ordered = [...groups.entries()]
    .map(([key, list]) => ({ key, list: [...list].sort((a, b) => a.at.localeCompare(b.at)) }))
    .sort((a, b) => a.list[0].at.localeCompare(b.list[0].at));

  const selected = traceId ? ordered.filter((group) => group.key === traceId) : ordered.slice(-last);
  if (!selected.length) {
    console.log(`（journal 里没有 traceId=${traceId} 的事件。）`);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(Object.fromEntries(selected.map((group) => [group.key, group.list])), null, 2));
    return;
  }

  console.log(`共 ${events.length} 条事件 / ${ordered.length} 次请求；本次展示 ${selected.length} 段。\n`);
  for (const group of selected) {
    const span = `${group.list[0].at} → ${group.list[group.list.length - 1].at}`;
    const sessionId = group.list.find((event) => event.sessionId)?.sessionId ?? "—";
    console.log(`── trace ${group.key === "background" ? "（后台任务）" : group.key}`);
    console.log(`   ${span} · ${group.list.length} 条事件 · session=${sessionId}`);
    for (const event of group.list) {
      console.log(`   ${event.at.slice(11, 23)} ${event.type.padEnd(18)} ${eventLine(event)}`);
    }
    console.log();
  }
}

main();
