import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadDotEnv } from "../config/dotenv.js";
import { buildLlmRuntimeProvider } from "../llm/runtime.js";
import { readJournal } from "../store/journal.js";
import { assembleJudgeTurns, axesFor, buildJudgePrompt, JUDGE_SYSTEM, parseJudgeResponse, priorTurns, type TurnVerdict } from "../eval/judge.js";

/**
  B 档第 3 刀：表达质量裁判（真发 LLM 调用、烧 token 的独立脚本——与零 token 的 phaseB:eval 严格分开）。
  判 rubric 已在 eval/judge.ts 预登记的四维：接续 / 接地 / 易读（全场景）+ 教学法契合（仅 teach）。
  证据必须逐字来自被评回复，编证据即驳回记 0；light 档未配置时整场报「未执行」，绝不回落确定性档冒充 judged。

  用法：pnpm phaseB:judge [仓库路径]（缺省取 repositories.json 唯一/首个仓库）
*/

loadDotEnv();

const here = (() => {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("-"));
  if (arg) return resolve(arg);
  const registry = join(homedir(), ".codebase-tutor", "repositories.json");
  if (!existsSync(registry)) throw new Error("未给仓库路径，且 repositories.json 不存在");
  const list = (JSON.parse(readFileSync(registry, "utf8")).repositories ?? []) as string[];
  if (!list.length) throw new Error("repositories.json 为空");
  return list[0];
})();

const out: string[] = [];
const emit = (line = ""): void => { out.push(line); };

emit(`# B 档第 3 刀：表达质量裁判报告`);
emit(`生成时间：${new Date().toISOString()}｜仓库：\`${here}\``);
emit();

const provider = buildLlmRuntimeProvider("light");
if (!provider) {
  emit("- **未执行**：light 档模型未配置。裁判维度的分数必须由模型给出，确定性档无话术可判——不跑、不造数。");
  console.log(out.join("\n"));
  process.exit(0);
}

const { turns, truncatedAnswers } = assembleJudgeTurns(readJournal(here));
if (!turns.length) {
  emit("- **未执行**：journal 里没有 turn_text 回合（先经 GUI 真实对话攒样本）。");
  console.log(out.join("\n"));
  process.exit(0);
}

const verdicts: TurnVerdict[] = [];
let failed = 0;
let inputTokens = 0;
let outputTokens = 0;
for (const turn of turns) {
  const prior = priorTurns(turns, turn);
  try {
    const completion = await provider.complete({
      system: JUDGE_SYSTEM,
      user: buildJudgePrompt(turn, prior),
      maxTokens: 700,
      temperature: 0,
      thinking: "off",
      scene: "eval.judge"
    });
    inputTokens += completion.usage?.inputTokens ?? 0;
    outputTokens += completion.usage?.outputTokens ?? 0;
    verdicts.push({ ...parseJudgeResponse(completion.text, turn), priorCount: prior.length });
  } catch (error) {
    failed += 1;
    emit(`- ⚠️ 回合 ${turn.at}（${turn.scene}）裁判调用失败，未计入均分：${error instanceof Error ? error.message : String(error)}`);
  }
}

emit(`- 数据源：journal turn_text ${turns.length} 回合（回复截断 ${truncatedAnswers} 条）｜成功判分 ${verdicts.length}、调用失败 ${failed}`);
emit(`- provider：${provider.name}｜model：${provider.modelVersion}｜token 消耗：输入 ${inputTokens}、输出 ${outputTokens}`);
emit();
emit("## 分场景维度均分（0-2 分制；驳回按预登记口径记 0 计入均分）");
emit();
const scenes = [...new Set(verdicts.map((verdict) => verdict.turn.scene))];
emit("| 场景 | 维度 | n | 均分 | 驳回（含分数/证据非法） | 判分失败回合 |");
emit("|---|---|---|---|---|---|");
for (const scene of scenes) {
  const scoped = verdicts.filter((verdict) => verdict.turn.scene === scene);
  for (const axis of axesFor(scene)) {
    const items = scoped.map((verdict) => verdict.axes[axis.key]).filter(Boolean);
    const mean = items.length ? items.reduce((sum, item) => sum + item.score, 0) / items.length : 0;
    const rejected = items.filter((item) => item.rejected).length;
    emit(`| ${scene} | ${axis.key} | ${items.length} | ${mean.toFixed(2)} | ${rejected} | ${scoped.filter((verdict) => verdict.parseFailed).length} |`);
  }
}
emit();
emit("## 逐回合明细");
for (const verdict of verdicts) {
  const scores = axesFor(verdict.turn.scene).map((axis) => {
    const item = verdict.axes[axis.key];
    return `${axis.key} ${item?.score ?? "—"}${item?.rejected ? `（驳回：${item.rejected}）` : ""}`;
  });
  emit(`- ${verdict.turn.at}｜${verdict.turn.scene}｜会话 ${verdict.turn.sessionId.slice(0, 8)}｜前情 ${verdict.priorCount} 轮｜${scores.join("、")}`);
}
emit();
emit("## 读数天花板（预登记）");
emit(`- 本报告的结论上限只到「${verdicts.length} 个回合的描述性统计」：n 为个位数时，均分差异不构成任何口径优劣判断，仅用于发现驳回率异常与明显坏样本。`);
emit("- 裁判看不到源码：「接地」维只判锚定具体性，锚点事实真伪以第 2 刀机检为准。");
console.log(out.join("\n"));
