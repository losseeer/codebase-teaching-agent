import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
  前缀缓存「刀 0」：只读 `~/.codebase-tutor/llm.log` 做基线统计，一条请求都不发、一行产品代码不改。

  要回答的问题只有一个：端点的**隐式前缀缓存**（同一段开头在第二次请求时按命中价计费）现在还剩多少可用。
  如果相邻两次请求的间隔普遍超过它的存活时间（TTL），那「把易变段挪到末尾、固定段前置」这类拼接改造
  就省不到钱——先看数再决定做几刀，别反过来。

  已知埋点缺口：llm.log 没有 threadId/sessionId 字段，所以这里只能按 scene 聚合，
  用「同 scene 上一次调用距今多久」当轮次间隔的代理值。要精确到线程内第 N 轮，
  得先给日志加一个 threadId（一行改动），那是刀 1 的前置，不是本刀的事。

  用法：pnpm cache:probe [llm.log 路径]
*/

const file = process.argv.slice(2).find((value) => !value.startsWith("-"));
const logPath = file ?? join(homedir(), ".codebase-tutor", "llm.log");
if (!existsSync(logPath)) {
  console.log(`# 前缀缓存基线（刀 0）\n\n- **未执行**：找不到 ${logPath}（还没发过任何 provider 调用）。`);
  process.exit(0);
}

interface LogRow {
  at?: string;
  scene?: string;
  ok?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheHitTokens?: number;
}

const rows = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line): LogRow | null => {
  try { return JSON.parse(line) as LogRow; } catch { return null; }
}).filter((row): row is LogRow => !!row && !!row.at);

// embedding 是另一件事（不计前缀缓存，也另本账），混进来只会把命中率稀释成噪声
const calls = rows.filter((row) => row.ok !== false && row.scene !== "embed" && (row.inputTokens ?? 0) > 0);
const byScene = new Map<string, LogRow[]>();
for (const row of calls) {
  const list = byScene.get(row.scene ?? "?");
  if (list) list.push(row);
  else byScene.set(row.scene ?? "?", [row]);
}

const gaps = new Map<string, { at: number; input: number; hit: number }[]>();
for (const [scene, list] of byScene) {
  const chrono = [...list].sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const series: { at: number; input: number; hit: number }[] = [];
  let previous = Number.NaN;
  for (const row of chrono) {
    const at = Date.parse(String(row.at));
    if (!Number.isNaN(previous)) series.push({ at: (at - previous) / 1000, input: row.inputTokens ?? 0, hit: row.cacheHitTokens ?? 0 });
    previous = at;
  }
  gaps.set(scene, series);
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

const out: string[] = [];
out.push("# 前缀缓存基线（刀 0，只读 llm.log，零请求）");
out.push(`样本：${calls.length} 次成功调用（已排除 embedding），时间跨度 ${calls.length ? String([...calls].sort((a, b) => String(a.at).localeCompare(String(b.at)))[0].at).slice(0, 10) : "—"} → ${calls.length ? String([...calls].sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1)?.at).slice(0, 10) : "—"}`);
out.push("");
out.push("## 1. 按场景：输入 token 的命中占比（改造的收益上限就在这列里）");
out.push("");
out.push("| 场景 | 调用数 | 输入 token | 命中 token | 命中率 | 完全没命中的调用 |");
out.push("|---|---|---|---|---|---|");
for (const [scene, list] of [...byScene].sort((left, right) => (right[1].reduce((total, row) => total + (row.inputTokens ?? 0), 0) - left[1].reduce((total, row) => total + (row.inputTokens ?? 0), 0)))) {
  const input = list.reduce((total, row) => total + (row.inputTokens ?? 0), 0);
  const hit = list.reduce((total, row) => total + (row.cacheHitTokens ?? 0), 0);
  const cold = list.filter((row) => !(row.cacheHitTokens ?? 0)).length;
  out.push(`| ${scene} | ${list.length} | ${input.toLocaleString()} | ${hit.toLocaleString()} | ${percent(hit, input)} | ${percent(cold, list.length)} |`);
}
out.push("");
out.push("## 2. 按「距同场景上一次调用的间隔」：命中率随间隔衰减成什么样");
out.push("");
out.push("对话类场景（teaching.turn / map.chat / practice.chat）单列——拼接改造只对它们有意义；批量类（map.summary / map.refine）在同一张表里做对照。");
out.push("");
out.push("| 场景 | 间隔档 | 次数 | 输入 token | 命中率 | 完全没命中 |");
out.push("|---|---|---|---|---|---|");
for (const scene of ["teaching.turn", "map.chat", "practice.chat", "map.summary", "map.refine"]) {
  const series = gaps.get(scene) ?? [];
  if (!series.length) { out.push(`| ${scene} | — | 0 | 0 | — | — |`); continue; }
  for (const band of bands) {
    const bucket = series.filter((item) => band.test(item.at));
    if (!bucket.length) continue;
    out.push(`| ${scene} | ${band.label} | ${bucket.length} | ${sum(bucket, "input").toLocaleString()} | ${percent(sum(bucket, "hit"), sum(bucket, "input"))} | ${percent(bucket.filter((item) => !item.hit).length, bucket.length)} |`);
  }
}
out.push("");
out.push("## 3. 读法（判「刀 1 拼接顺序值不值得做」）");
out.push("");
out.push("- 若**短间隔档命中率明显高、长间隔档掉到接近 0**：TTL 在起作用，改造的天花板 = 把易变段挪到末尾后能让多少调用落回短间隔档——收益按该档输入 token 占比折算。");
out.push("- 若**各档命中率都差不多**：端点没在按间隔给折扣（或折扣与间隔无关），刀 1 的收益基本为零，应该转去做刀 2（真多轮 messages）或直接放弃这条线。");
out.push("- 批量场景（map.summary / map.refine）命中率天然高是**同一段系统提示被反复命中**的结果，不能拿来当对话场景的对照基线。");
out.push("");
out.push("埋点缺口：llm.log 目前没有 threadId，以上间隔是「同场景相邻调用」的间隔而非「同一会话线程相邻轮次」的间隔。要精确判刀 2，先给日志补一个 threadId。");
console.log(out.join("\n"));
