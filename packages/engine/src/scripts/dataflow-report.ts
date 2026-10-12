import { existsSync, readFileSync } from "node:fs";
import { llmLogPath, type LlmCallRecord } from "../llm/call-log.js";
import { readJournal } from "../store/journal.js";
import type { JournalEvent } from "@codebase-tutor/shared";

/**
  LLM 数据流审计报表（企业化第 3 条，纯只读、零 token）。

  回答一个问题：**这台机器把哪些代码交给了谁**。两条线各答一半，靠 `traceId + scene` 关联：
  - `<仓>/.tutor/journal.jsonl` 的 `code_egress`（哪些文件、哪几行、多少字符、指纹、隐去过几处）
    与 `file_read`（工具循环读到的内容在下一轮出门，同样算出境，带 `对端仓/` 前缀的就是跨仓）；
  - `~/.codebase-tutor/llm.log`（provider、model、token、调用方 `actor`、载荷指纹）。

  两条口径必须说在前面，否则这张表会骗人：
  1. **后台任务（导入期的 L1 摘要、监听触发的重分析）没有 traceId**，两条线都记 null，
     所以那部分调用**不能按仓归属**——本仓的文件清单来自 journal（逐文件准确），
     而那批调用的 provider/token 只能给全局数。要按人算账就配上 API key（见 §44 的 `actor`）。
  2. **只有装进请求的源码原文才落清单**。推荐入口、课程树润色、意图/动作分类这些 scene 送的是
     派生产物（路径、标题、摘要），按设计没有 `code_egress` 行；报表末尾把它们列出来，
     「没有清单」与「漏了清单」是两件事，得让人分得清。

  用法：pnpm dataflow:report -- <被学习仓路径> [--since 2026-10-01] [--limit 20] [--actor <key 名>] [--json]
  */

interface EgressRow {
  at: string;
  scene: string;
  kind: string;
  path: string;
  lines: string;
  chars: number;
  masked: number;
  /** 这一段有没有「隐去」这个读数可说：`false` = 那行写于 §43 上线之前，缺字段不等于扫过且干净 */
  maskedRecorded: boolean;
  truncated: boolean;
  traceId: string | null;
  sessionId: string | null;
  via: "assembled" | "tool-read";
}

interface FileStat {
  path: string;
  hits: number;
  maxChars: number;
  totalChars: number;
  masked: number;
  /** 有几段来自还没写「隐去」读数的旧行——这一格不是 0，是「无从判定」 */
  maskedUnknown: number;
  scenes: Set<string>;
  kinds: Set<string>;
  lastAt: string;
}

function scalarOf(row: JournalEvent, key: string): string | number | undefined {
  const value = row.payload[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/**
  「隐去处数」这一格从 2026-10-11（§43 入口过筛 + §45 出境清单）才开始写。
  journal 是 append-only 且没有行版本号，所以只能按日期判：**旧行的缺字段不等于「扫过且干净」**，
  拿 0 冒充会把「我们没检查过」说成「检查过没命中」。
  */
const MASKED_SINCE = "2026-10-11";

/** journal 的两条出境来源合并成一张清单：装配期登记的 `code_egress` + 工具循环的 `file_read`。 */
function egressRowsOf(events: JournalEvent[]): EgressRow[] {
  const rows: EgressRow[] = [];
  for (const event of events) {
    if (event.type === "code_egress") {
      const chars = Number(scalarOf(event, "chars") ?? 0);
      rows.push({
        at: event.at,
        scene: String(scalarOf(event, "scene") ?? "未记"),
        kind: String(scalarOf(event, "kind") ?? "未记"),
        path: String(scalarOf(event, "path") ?? "未记"),
        lines: String(scalarOf(event, "lines") ?? "未记"),
        chars: Number.isFinite(chars) ? chars : 0,
        masked: Number(scalarOf(event, "masked") ?? 0) || 0,
        maskedRecorded: true,
        truncated: event.payload.truncated === true,
        traceId: event.traceId ?? null,
        sessionId: event.sessionId ?? null,
        via: "assembled"
      });
      continue;
    }
    if (event.type !== "file_read") continue;
    // 被拒与读失败的调用没拿到内容，也就没东西可出境
    if (event.payload.denied === true || typeof event.payload.error === "string") continue;
    const lines = Number(scalarOf(event, "lines") ?? 0);
    rows.push({
      at: event.at,
      scene: "tool-loop",
      kind: "tool-read",
      // 跨仓那档的 path 由工具层带上「对端仓名/」前缀（journal 只有 path 一个字段，不带仓名分不出是谁家的文件）
      path: String(scalarOf(event, "path") ?? "未记"),
      lines: `${lines} 行`,
      // file_read 那行记的是行数不是字符数：这一格留 0（报表里显示为「未量」），不编一个字符数
      chars: 0,
      masked: Number(scalarOf(event, "masked") ?? 0) || 0,
      maskedRecorded: event.at >= MASKED_SINCE,
      truncated: event.payload.truncated === true,
      traceId: event.traceId ?? null,
      sessionId: event.sessionId ?? null,
      via: "tool-read"
    });
  }
  return rows;
}

function loadLlmRows(since: string | undefined): LlmCallRecord[] {
  const target = llmLogPath();
  if (!target || !existsSync(target)) return [];
  const rows: LlmCallRecord[] = [];
  for (const line of readFileSync(target, "utf8").split("\n")) {
    if (!line.trim()) continue;
    // 一行坏数据不该让整张报表消失（与 run-trace 同一容错口径）
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = parsed as LlmCallRecord;
    if (typeof row.at !== "string" || typeof row.scene !== "string") continue;
    if (since && row.at < since) continue;
    rows.push(row);
  }
  return rows;
}

function byFile(rows: EgressRow[]): Map<string, FileStat> {
  const map = new Map<string, FileStat>();
  for (const row of rows) {
    const stat = map.get(row.path) ?? {
      path: row.path, hits: 0, maxChars: 0, totalChars: 0, masked: 0, maskedUnknown: 0,
      scenes: new Set<string>(), kinds: new Set<string>(), lastAt: ""
    };
    stat.hits += 1;
    stat.maxChars = Math.max(stat.maxChars, row.chars);
    stat.totalChars += row.chars;
    stat.masked += row.masked;
    if (!row.maskedRecorded) stat.maskedUnknown += 1;
    stat.scenes.add(row.scene);
    stat.kinds.add(row.kind);
    if (row.at > stat.lastAt) stat.lastAt = row.at;
    map.set(row.path, stat);
  }
  return map;
}

const num = (value: number): string => value.toLocaleString("en-US");
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

function main(): void {
  const args = process.argv.slice(2);
  const repoPath = args.find((arg) => !arg.startsWith("--"));
  if (!repoPath) {
    console.error("用法：tsx src/scripts/dataflow-report.ts <被学习仓路径> [--since 2026-10-01] [--limit 20] [--actor <key 名>] [--json]");
    process.exit(2);
  }
  const take = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const since = take("--since");
  const actorFilter = take("--actor");
  const limit = Number(take("--limit") ?? 20) || 20;
  const asJson = args.includes("--json");

  const events = readJournal(repoPath);
  if (!events.length) {
    console.log(`（${repoPath}/.tutor/journal.jsonl 为空或不存在——这个仓还没有任何出境记录可查。）`);
    return;
  }
  const rows = egressRowsOf(events);
  const traceIds = new Set(events.map((event) => event.traceId).filter((traceId): traceId is string => Boolean(traceId)));
  const allLlm = loadLlmRows(since);
  const attributable = allLlm.filter((row) => row.traceId && traceIds.has(row.traceId));
  const background = allLlm.filter((row) => !row.traceId);
  const scoped = actorFilter ? attributable.filter((row) => row.actor === actorFilter) : attributable;

  const files = [...byFile(rows).values()].sort((a, b) => b.hits - a.hits || b.totalChars - a.totalChars || a.path.localeCompare(b.path));
  const providers = new Map<string, { calls: number; input: number; output: number; cache: number; actors: Set<string> }>();
  for (const row of scoped) {
    const key = `${row.provider} · ${row.model}`;
    const bucket = providers.get(key) ?? { calls: 0, input: 0, output: 0, cache: 0, actors: new Set<string>() };
    bucket.calls += 1;
    bucket.input += row.inputTokens ?? 0;
    bucket.output += row.outputTokens ?? 0;
    bucket.cache += row.cacheHitTokens ?? 0;
    bucket.actors.add(row.actor ?? "（本机·未认证）");
    providers.set(key, bucket);
  }
  const scenesWithCalls = new Set(scoped.map((row) => row.scene));
  // 工具循环读到的内容随同一 trace 的后续调用出门，所以「这一趟有没有源码出境」要把 tool-read 也算上：
  // 只按 code_egress 的 scene 判，会把「模型自己读了两页源码」的对话报成「没有清单」。
  const coveredScenes = new Set(rows.map((row) => row.scene));
  const toolTraces = new Set(rows.filter((row) => row.via === "tool-read" && row.traceId).map((row) => row.traceId as string));
  for (const call of scoped) if (call.traceId && toolTraces.has(call.traceId)) coveredScenes.add(call.scene);
  const noInventory = [...scenesWithCalls].filter((scene) => !coveredScenes.has(scene)).sort();
  const maskedTotal = rows.reduce((total, row) => total + row.masked, 0);
  const maskedUnknown = rows.filter((row) => !row.maskedRecorded).length;
  const window = rows.length ? `${rows.reduce((min, row) => (row.at < min ? row.at : min), rows[0].at).slice(0, 10)} → ${rows.reduce((max, row) => (row.at > max ? row.at : max), rows[0].at).slice(0, 10)}` : "—";

  if (asJson) {
    console.log(JSON.stringify({
      repository: repoPath,
      window,
      since: since ?? null,
      egress: { segments: rows.length, files: files.length, chars: rows.reduce((total, row) => total + row.chars, 0), masked: maskedTotal, truncated: rows.filter((row) => row.truncated).length },
      byFile: files,
      // 逐段清单（不带 --limit）：机检与「拿一段去重跑装配比哈希」的核对都用它
      segments: rows,
      calls: { attributable: scoped.length, providers: [...providers.entries()].map(([name, value]) => ({ name, ...value, input: value.input, actors: [...value.actors] })), backgroundUnattributed: background.length },
      scenesWithoutInventory: noInventory
    }, (_key, value) => (value instanceof Set ? [...value] : value), 2));
    return;
  }

  console.log(`数据流审计 · ${repoPath}`);
  console.log(`样本窗口 ${window}${since ? ` · --since ${since}` : ""} · llm.log：${llmLogPath() ?? "（只打控制台，未落盘）"}`);
  console.log(`源码出境 ${num(rows.length)} 段，覆盖 ${num(files.length)} 个文件；` + (maskedTotal
    ? `其中 ${maskedTotal} 处疑似密钥在发出前被隐去。`
    : `没有命中过密钥隐去${maskedUnknown ? `（另有 ${maskedUnknown} 段写于该读数上线之前，那一格无从判定，不等于「扫过且干净」）` : ""}。\n`));

  console.log("── 出境去向（按 provider · 只算能归属到本仓的调用）");
  if (!providers.size) console.log("   （这个窗口里没有可归属的模型调用——后台任务的调用不带 traceId，见下方说明）");
  for (const [name, bucket] of [...providers.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(`   ${clip(name, 46).padEnd(46)} 调用 ${String(bucket.calls).padStart(4)} 次 · 输入 ${num(bucket.input)}（命中 ${num(bucket.cache)}）· 输出 ${num(bucket.output)} · 调用方 ${[...bucket.actors].join("、")}`);
  }

  console.log("\n── 被看过的文件（Top " + Math.min(limit, files.length) + "，次数＝出境段数）");
  console.log(`   ${"路径".padEnd(44)} ${"次数".padStart(5)} ${"最多字符".padStart(9)} ${"隐去".padStart(5)}  形态 · 场景`);
  for (const file of files.slice(0, limit)) {
    // 工具循环那些行只记了行数没记字符数，这一格老实写「未量」，不拿 0 冒充「零字符出境」
    const chars = file.maxChars ? num(file.maxChars) : "未量";
    const masked = file.masked ? String(file.masked) : file.maskedUnknown ? "—" : "-";
    console.log(`   ${clip(file.path, 44).padEnd(44)} ${String(file.hits).padStart(5)} ${chars.padStart(9)} ${masked.padStart(5)}  ${clip([...file.kinds].join("/"), 24).padEnd(24)} ${[...file.scenes].join(",").slice(0, 46)}`);
  }
  console.log("   （「隐去」列：数字＝隐去处数；-＝扫过且干净；—＝这些段写于该读数上线前，无从判定。「未量」＝工具循环只记了行数，没记字符数。）");

  const paired = events.filter((event) => event.type === "repository_paired");
  if (paired.length) {
    const partners = new Set(paired.map((event) => String(event.payload.other_repository_id ?? "未记")));
    console.log(`\n── 跨仓配对 ${paired.length} 次（配一次读两个仓），对端：${[...partners].join(" / ")}`);
    console.log("   跨仓读到的文件在上面的清单里带「对端仓名/」前缀；按仓授权生效时，名单外的对端连仓名都不下发（§44）。");
  }

  if (background.length) {
    const byScene = new Map<string, number>();
    for (const row of background) byScene.set(row.scene, (byScene.get(row.scene) ?? 0) + 1);
    console.log(`\n── 后台任务的调用（traceId 为 null）：${background.length} 次，不能按仓归属`);
    console.log(`   主要场景：${[...byScene.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([scene, count]) => `${scene}×${count}`).join(" ")}`);
    console.log("   这一档的**文件清单仍然逐文件准确**（来自本仓 journal 的 code_egress），只有 provider/token 是全局数。");
  }

  console.log(`\n── 有调用但没有任何源码出境的场景（${noInventory.length ? "按设计：这些调用送的是派生内容——路径、标题、摘要，不是源码原文" : "无——每个有调用的场景都有源码清单（装配期摘录或工具读取）"}）`);
  if (noInventory.length) console.log(`   ${noInventory.join("  ")}`);

  const traced = rows.find((row) => row.traceId);
  if (traced?.traceId) console.log(`\n核对：任取一段在本地重跑同一次装配、比 payload 的 hash 与 llm.log 的 outbound.hash；整回合过程看 pnpm run-trace ${repoPath} --trace ${traced.traceId}`);
}

main();
