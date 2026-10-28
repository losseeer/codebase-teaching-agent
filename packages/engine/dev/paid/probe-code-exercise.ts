/**
  真模型出题探针（付费）：打一次端点，看模型能否交出沙箱两跑自证的题。
  只读 `tutor.db`，不落练习缓存；源码出境照记 `code_egress` 审计行。
  用法：pnpm probe:code-exercise /absolute/path/to/repository [patch_edit|author_function]
*/
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExerciseKind, RepositoryAnalysis } from "@codebase-tutor/domain";

import { loadDotEnv } from "../../src/boot.js";
import { buildLlmRuntimeProvider, restoreLlmRuntimeSettings } from "../../src/adapter/outbound/llm/runtime.js";
import { generateCodeExercise } from "../../src/exercises/code-generate.js";
import { ensureIsolation } from "../../src/adapter/outbound/sandbox/isolation.js";
import { resolve } from "node:path";

const repositoryPath = resolve(process.argv[2] ?? "");
const kind = (process.argv[3] === "author_function" ? "author_function" : "patch_edit") as ExerciseKind;
if (!repositoryPath) {
  console.log("用法：pnpm probe:code-exercise /absolute/path/to/repository [patch_edit|author_function]");
  process.exit(0);
}

// 开机顺序照 server.ts；角色取 light，与练习路由同一档。
loadDotEnv();
restoreLlmRuntimeSettings();
const provider = buildLlmRuntimeProvider("light");
if (!provider) {
  console.log(`# 真模型出题探针\n\n- 未执行：没有解析出模型档（未配置或本月预算已达上限）。零调用、零支出。`);
  process.exit(0);
}

const databaseFile = join(repositoryPath, ".tutor", "tutor.db");
if (!existsSync(databaseFile)) { console.log(`- 没有 ${databaseFile}`); process.exit(0); }
const database = new DatabaseSync(databaseFile, { readOnly: true });
const row = database.prepare("SELECT analysis_json FROM repository_state WHERE analysis_json IS NOT NULL ORDER BY updated_at DESC").get() as { analysis_json: string } | undefined;
database.close();
if (!row) { console.log("- 产物里没有 analysis_json"); process.exit(0); }
const analysis = JSON.parse(row.analysis_json) as RepositoryAnalysis;

const supported = new Set(["typescript", "python", "java"]);
const candidates = analysis.implementations.filter((unit) => supported.has(unit.symbol.language));
// 候选：函数/方法里取行跨度最接近 8 行的一个。
const chosen = candidates
  .filter((unit) => unit.symbol.kind === "function" || unit.symbol.kind === "method")
  .sort((left, right) => Math.abs((left.symbol.endLine - left.symbol.line) - 8) - Math.abs((right.symbol.endLine - right.symbol.line) - 8))
  .slice(0, 1);
if (!chosen.length) { console.log("- 这门仓里没有合适的候选单元"); process.exit(0); }
const unit = chosen[0]!;
console.log(`# 真模型出题探针 · ${repositoryPath.split("/").pop()}`);
console.log(`\n- 模型：${provider.modelVersion}｜候选单元 ${candidates.length} 个｜本次挑的是 ${unit.symbol.name}（${unit.symbol.path}:${unit.symbol.line}-${unit.symbol.endLine}，${unit.symbol.language}，${unit.symbol.parameters.length} 个参数）`);
// 探一次（探过就认缓存），读数才与线上同源：不探就永远读到 unknown，与产品闸门两个说法
const isolationProbe = await ensureIsolation();
console.log(`- 隔离：${isolationProbe.level}（${isolationProbe.reason}）`);
if (isolationProbe.level !== "enforced") {
  // 与产品同一道闸门：`nextCode` 在发模型请求之前就拒，探针跟着它走。
  console.log("\n沙箱不可用，这一趟不发模型请求（零花费）。");
  process.exit(0);
}
console.log(`- 题型：${kind}\n`);

const started = Date.now();
const generation = await generateCodeExercise({ repositoryPath, unit, kind: kind === "author_function" ? "author_function" : "patch_edit", provider });
const elapsed = Date.now() - started;
for (const run of generation.runs) {
  console.log(`- 自证 ${run.label}：TESTS ${run.verdict ? `${run.verdict.passed} 通过 ${run.verdict.failed} 失败` : "没有输出结论"}｜exit=${run.exitCode ?? "null"}${run.timedOut ? "｜超时" : ""}`);
}
if (!generation.ok) {
  console.log(`\n拒题（stage=${generation.stage}，${elapsed}ms）：${generation.reason}`);
  // 这里不能 process.exit：`call-log` 用异步 appendFile，立刻退出会截掉这一笔。
} else {
const proposal = generation.proposal;
console.log(`\n两跑自证通过（${elapsed}ms）：${proposal.title}`);
console.log(`- 题面：${proposal.prompt.slice(0, 160)}`);
console.log(`- 缺陷（留档不下发）：${proposal.defect}`);
console.log(`- 文件：下发 ${proposal.given.length} 个 / 判分 ${proposal.hidden.length} 个｜入口 ${proposal.entry}`);
for (const file of [...proposal.given, ...proposal.hidden]) console.log(`  · ${file.path}（${file.contents.split("\n").length} 行）`);
console.log(`- token：${generation.usage ? `输入 ${generation.usage.inputTokens} / 输出 ${generation.usage.outputTokens}（缓存命中 ${generation.usage.promptCacheHitTokens ?? 0}）` : "没带回用量"}`);
console.log(`\n> 探针不落练习缓存；源码出网那一行 \`code_egress\` 照写（scene=practice.generate-code），实耗以 ~/.codebase-tutor/llm.log 为准。`);
}
