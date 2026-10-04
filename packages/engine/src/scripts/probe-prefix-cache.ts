import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
  前缀缓存基线（只读 llm.log，零请求）：回答「端点的隐式前缀缓存现在还剩多少可用」。
  如果相邻两次请求的间隔普遍超过它的存活时间（TTL），那「把易变段挪到末尾、固定段前置」这类拼接改造
  就省不到钱——先看数再决定做几刀，别反过来。

  间隔有两个口径，第 2 节是真值、第 3 节是代理值：
  - **同一线程的相邻两轮**（threadId 相同、traceId 不同）：学习者看完回答再追问的那段时间，
    这才是和 TTL 打架的数字。一次回合内部的多次调用不算——它们隔着不到一秒，
    命不命中由端点自己决定，混进来只会把间隔压成 0 制造假繁荣。
  - **同场景的相邻调用**：不需要 threadId 就能算，用来覆盖 10-04 之前的历史行。
    它会把两个不同会话的相邻提问当成一次「间隔」，所以只能当下限参考。

  threadId 是 2026-10-04 补进 llm.log 的（trace/context.ts 的 markThread）：那之前的行没有这个字段，
  在第 2 节里自然缩出样本——不是 bug，是样本起点。

  用法：pnpm cache:probe [llm.log 路径]
*/

const file = process.argv.slice(2).find((value) => !value.startsWith("-"));
const logPath = file ?? join(homedir(), ".codebase-tutor", "llm.log");
if (!existsSync(logPath)) {
  console.log(`# 前缀缓存基线\n\n- **未执行**：找不到 ${logPath}（还没发过任何 provider 调用）。`);
  process.exit(0);
}

interface LogRow {
  at?: string;
  scene?: string;
  ok?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
  traceId?: string | null;
  /** 2026-10-04 之前的历史行没有这个字段 */
  threadId?: string | null;
}

interface Turn {
  at: number;
  scene: string;
  input: number;
  hit: number;
}

const rows = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line): LogRow | null => {
  try { return JSON.parse(line) as LogRow; } catch { return null; }
}).filter((row): row is LogRow => !!row && !!row.at);

// embedding 是另一件事（不计前缀缓存，也另本账），混进来只会把命中率稀释成噪声
const calls = rows.filter((row) => row.ok !== false && row.scene !== "embed" && (row.inputTokens ?? 0) > 0);
const chronoOf = (list: LogRow[]): LogRow[] => [...list].sort((left, right) => String(left.at).localeCompare(String(right.at)));

const byScene = new Map<string, LogRow[]>();
for (const row of calls) {
  const list = byScene.get(row.scene ?? "?");
  if (list) list.push(row);
  else byScene.set(row.scene ?? "?", [row]);
}

const gaps = new Map<string, { at: number; input: number; hit: number }[]>();
for (const [scene, list] of byScene) {
  const series: { at: number; input: number; hit: number }[] = [];
  let previous = Number.NaN;
  for (const row of chronoOf(list)) {
    const at = Date.parse(String(row.at));
    if (!Number.isNaN(previous)) series.push({ at: (at - previous) / 1000, input: row.inputTokens ?? 0, hit: row.cacheHitTokens ?? 0 });
    previous = at;
  }
  gaps.set(scene, series);
}

/**
  线程维度：一次回合 = 一个 traceId（教学回合内部就有「动作提议 + 措辞」两趟调用），
  所以先按 traceId 折成回合，再算相邻回合的间隔。
  命中只取该回合**第一趟**调用——它的 prompt 里才装着上一轮的对话；同回合第二趟的命中
  是回合内部的复用，与「缓存能不能撑过学习者的思考时间」这个问题无关。
  */
const byThread = new Map<string, LogRow[]>();
for (const row of calls) {
  if (!row.threadId) continue;
  const list = byThread.get(row.threadId);
  if (list) list.push(row);
  else byThread.set(row.threadId, [row]);
}
interface ThreadSummary { threadId: string; scenes: string; calls: number; turns: Turn[]; input: number; hit: number }
const threads: ThreadSummary[] = [];
for (const [threadId, list] of byThread) {
  const turns: Turn[] = [];
  const seen = new Set<string>();
  for (const row of chronoOf(list)) {
    // 无 traceId 的行按时间戳各算一轮（后台任务串进线程，理论上不该出现，出现了也不合并）
    const key = row.traceId ?? String(row.at);
    if (seen.has(key)) continue;
    seen.add(key);
    turns.push({ at: Date.parse(String(row.at)), scene: row.scene ?? "?", input: row.inputTokens ?? 0, hit: row.cacheHitTokens ?? 0 });
  }
  threads.push({
    threadId,
    scenes: [...new Set(list.map((row) => row.scene ?? "?"))].join("/"),
    calls: list.length,
    turns,
    input: turns.reduce((total, turn) => total + turn.input, 0),
    hit: turns.reduce((total, turn) => total + turn.hit, 0)
  });
}
const turnGaps: { seconds: number; scene: string; input: number; hit: number }[] = [];
for (const thread of threads) {
  for (let index = 1; index < thread.turns.length; index += 1) {
    const current = thread.turns[index];
    turnGaps.push({ seconds: (current.at - thread.turns[index - 1].at) / 1000, scene: current.scene, input: current.input, hit: current.hit });
  }
}

const bands: { label: string; test: (seconds: number) => boolean }[] = [
  { label: "≤30 秒", test: (seconds) => seconds <= 30 },
  { label: "30 秒~2 分", test: (seconds) => seconds > 30 && seconds <= 120 },
  { label: "2~10 分", test: (seconds) => seconds > 120 && seconds <= 600 },
  { label: "10~60 分", test: (seconds) => seconds > 600 && seconds <= 3600 },
  { label: ">60 分", test: (seconds) => seconds > 3600 }
];

const percent = (part: number, whole: number): string => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");
const sum = (list: { input: number; hit: number }[], key: "input" | "hit"): number => list.reduce((total, item) => total + item[key], 0);
const median = (values: number[]): number | undefined => (values.length ? [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] : undefined);

const chatScenes = ["teaching.turn", "map.chat", "practice.chat"];
const threaded = calls.filter((row) => row.threadId).length;
const multiTurn = threads.filter((thread) => thread.turns.length > 1).length;

const out: string[] = [];
out.push("# 前缀缓存基线（只读 llm.log，零请求）");
out.push(`样本：${calls.length} 次成功调用（已排除 embedding），时间跨度 ${chronoOf(calls)[0]?.at?.slice(0, 10) ?? "—"} → ${chronoOf(calls).at(-1)?.at?.slice(0, 10) ?? "—"}`);
out.push("");
out.push("## 1. 按场景：输入 token 的命中占比（改造的收益上限就在这列里）");
out.push("");
out.push("| 场景 | 调用数 | 输入 token | 命中 token | 命中率 | 完全没命中的调用 |");
out.push("|---|---|---|---|---|---|");
for (const [scene, list] of [...byScene].sort((left, right) => (right[1].reduce((total, row) => total + (row.inputTokens ?? 0), 0) - left[1].reduce((total, row) => total + (row.inputTokens ?? 0), 0)))) {
  const input = sum(list.map((row) => ({ input: row.inputTokens ?? 0, hit: row.cacheHitTokens ?? 0 })), "input");
  const hit = sum(list.map((row) => ({ input: row.inputTokens ?? 0, hit: row.cacheHitTokens ?? 0 })), "hit");
  const cold = list.filter((row) => !(row.cacheHitTokens ?? 0)).length;
  out.push(`| ${scene} | ${list.length} | ${input.toLocaleString()} | ${hit.toLocaleString()} | ${percent(hit, input)} | ${percent(cold, list.length)} |`);
}
out.push("");
out.push("## 2. 同一会话线程的相邻两轮（真值：threadId 相同、traceId 不同）");
out.push("");
out.push(`带 threadId 的调用 ${threaded}/${calls.length} 次，覆盖 ${threads.length} 个线程，其中 ${multiTurn} 个问到了第 2 轮以上 → 轮次间隔样本 ${turnGaps.length} 个。`);
out.push("");
if (turnGaps.length) {
  out.push("| 间隔档 | 次数 | 该轮输入 token | 命中 token | 跨轮命中率 | 完全没命中 |");
  out.push("|---|---|---|---|---|---|");
  for (const band of bands) {
    const bucket = turnGaps.filter((item) => band.test(item.seconds));
    if (!bucket.length) continue;
    out.push(`| ${band.label} | ${bucket.length} | ${sum(bucket, "input").toLocaleString()} | ${sum(bucket, "hit").toLocaleString()} | ${percent(sum(bucket, "hit"), sum(bucket, "input"))} | ${percent(bucket.filter((item) => !item.hit).length, bucket.length)} |`);
  }
  const chat = turnGaps.filter((item) => chatScenes.includes(item.scene));
  out.push("");
  out.push(`轮次间隔中位数：${median(turnGaps.map((item) => item.seconds))?.toFixed(1) ?? "—"} 秒；对话类场景的跨轮命中率：${percent(sum(chat, "hit"), sum(chat, "input"))}（${chat.length} 个间隔）。`);
} else {
  out.push("（还没有跨轮样本：要么 threadId 埋点刚上、还没在同一线程里问过第二次，要么历史行都没这个字段。攒样本期间以下表为准。）");
}
out.push("");
out.push("| 线程 | 场景 | 调用数 | 回合数 | 输入 token | 命中 token | 命中率 |");
out.push("|---|---|---|---|---|---|---|");
for (const thread of [...threads].sort((left, right) => right.turns.length - left.turns.length).slice(0, 20)) {
  out.push(`| ${thread.threadId.slice(0, 8)} | ${thread.scenes} | ${thread.calls} | ${thread.turns.length} | ${thread.input.toLocaleString()} | ${thread.hit.toLocaleString()} | ${percent(thread.hit, thread.input)} |`);
}
if (!threads.length) out.push("| — | — | 0 | 0 | 0 | 0 | — |");
out.push("");
out.push("## 3. 按「距同场景上一次调用的间隔」（代理值，覆盖没有 threadId 的历史行）");
out.push("");
out.push("对话类场景（teaching.turn / map.chat / practice.chat）单列——拼接改造只对它们有意义；批量类（map.summary / map.refine）在同一张表里做对照。");
out.push("");
out.push("| 场景 | 间隔档 | 次数 | 输入 token | 命中率 | 完全没命中 |");
out.push("|---|---|---|---|---|---|");
for (const scene of [...chatScenes, "map.summary", "map.refine"]) {
  const series = gaps.get(scene) ?? [];
  if (!series.length) { out.push(`| ${scene} | — | 0 | 0 | — | — |`); continue; }
  for (const band of bands) {
    const bucket = series.filter((item) => band.test(item.at));
    if (!bucket.length) continue;
    out.push(`| ${scene} | ${band.label} | ${bucket.length} | ${sum(bucket, "input").toLocaleString()} | ${percent(sum(bucket, "hit"), sum(bucket, "input"))} | ${percent(bucket.filter((item) => !item.hit).length, bucket.length)} |`);
  }
}
out.push("");
out.push("## 4. 读法（判刀 1「拼接顺序」与刀 2「真多轮 messages」各值不值得做）");
out.push("");
out.push("- **第 2 节短间隔档命中率高、且学习者就是在这些间隔里追问**：刀 1 有明确天花板，按该档输入 token 占比折算就知道能省多少。");
out.push("- **第 2 节没样本而第 3 节有数**：第 3 节的间隔是「两个不同会话碰巧挨着」造出来的假象，不能拿来判刀 1。先正常用 GUI 多问几轮攒样本，别改代码。");
out.push("- **各档命中率都差不多**：端点没按间隔给折扣，刀 1 收益基本为零，转刀 2（同一线程拼成真 messages 数组，让命中靠请求本身而不是时序运气）或直接放弃这条线。");
out.push("- 批量场景（map.summary / map.refine）命中率天然高是**同一段系统提示被反复命中**的结果，不能当对话场景的对照基线。");
console.log(out.join("\n"));
