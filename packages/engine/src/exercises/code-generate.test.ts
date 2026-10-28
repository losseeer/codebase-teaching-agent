import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RepositoryAnalysis } from "@codebase-tutor/domain";

import { buildDependencyGraph, serializeGraph } from "@codebase-tutor/analysis";
import { buildImplementationUnits } from "../implementation/units.js";
import { indexRepository } from "../indexer/indexer.js";
import type { LlmProvider } from "../application/port/llm-provider.js";
import { readJournal } from "../adapter/outbound/persistence/journal.js";
import { TutorDatabase } from "../adapter/outbound/persistence/database.js";
import { RepositoryHandle } from "../adapter/outbound/persistence/repository-handle.js";
import { nestedSandboxUsable } from "../adapter/outbound/sandbox/capability.js";
import { exercisePortsFor } from "../infrastructure/exercise-ports.js";
import { ExerciseService, type PracticeRepository } from "./exercises.js";

/**
  代码题是集成用例：假 provider 交手工 harness（零模型调用），自证、判分、讲评都真起沙箱。
  环境不支持嵌套 `sandbox-exec` 时整片跳过并在输出里点名。
*/
const capability = nestedSandboxUsable();
if (!capability.usable) console.warn(`[code-exercise] 本机起不了嵌套 sandbox-exec（${capability.detail}）：整份代码题集成用例按「环境不支持」跳过，这不是通过`);
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../../test-fixtures/frozen-demo-repo");
const temporaryDirectories: string[] = [];
/** 夹具的真句柄：收尾先关连接再删目录。 */
const handles: RepositoryHandle[] = [];

afterEach(() => {
  // 先放开 builder 那次 pin 再关连接：否则 close 会挂起。
  for (const handle of handles.splice(0)) {
    handle.unpin();
    handle.close();
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function testRepository(): PracticeRepository {
  const directory = mkdtempSync(join(tmpdir(), "tutor-code-ex-"));
  temporaryDirectories.push(directory);
  const repositoryPath = join(directory, "fixture");
  cpSync(fixture, repositoryPath, { recursive: true, filter: (source) => !source.includes("/.tutor") });
  const index = indexRepository(repositoryPath);
  const graph = buildDependencyGraph(repositoryPath, index.files);
  const analysis: RepositoryAnalysis = {
    repositoryId: index.repositoryId,
    generatedAt: "2026-01-01T00:00:00.000Z",
    graph: serializeGraph(graph),
    implementations: buildImplementationUnits(repositoryPath, graph.symbols),
    versionStamp: "content-v1"
  };
  const handle = openHandle(repositoryPath, index.repositoryId);
  // 夹具在这里装配一次真存储；引用由 afterEach 放开。
  return { path: repositoryPath, index, analysis, ports: exercisePortsFor(handle, handle.pin()) };
}

/** 夹具用真句柄：出题与判分都经这份连接读写产物库。 */
function openHandle(repositoryPath: string, repositoryId: string): RepositoryHandle {
  const handle = new RepositoryHandle(repositoryPath, repositoryId);
  handles.push(handle);
  return handle;
}

/** 真源码那一份：patch_edit 的 solution 必须逐字含它。 */
const REAL_SOURCE = 'export function loadGreeting(environment) {\n  return environment.GREETING || "hello";\n}\n';
const DEFECTIVE_SOURCE = 'export function loadGreeting(environment) {\n  return environment.GREETING || "hallo";\n}\n';
/** 语法有错的源码：跑不出 TESTS 结论。 */
const UNPARSABLE_SOURCE = 'export function loadGreeting(environment) {\n  return environment.GREETING || ;\n}\n';

const TESTS = `import { loadGreeting } from "./target.ts";
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean): void => { if (ok) pass += 1; else { fail += 1; console.error(name); } };
check("没给问候时用默认值", loadGreeting({}) === "hello");
check("给了问候时用传入值", loadGreeting({ GREETING: "hi" }) === "hi");
console.log(\`TESTS \${pass} \${fail}\`);
if (fail > 0) process.exitCode = 1;
`;

interface HarnessInput { given: string; solution: string }
function proposalJson(input: HarnessInput): string {
  return JSON.stringify({
    ok: true,
    language: "typescript",
    title: "把默认问候改回来",
    prompt: "下面这个函数在没给 GREETING 时返回了错的字串，改到测试全过。",
    defect: "默认值拼错了：应当是 hello，写成了 hallo。",
    given: [{ path: "target.ts", contents: input.given }],
    solution: [{ path: "target.ts", contents: input.solution }],
    hidden: [{ path: "tests.ts", contents: TESTS }],
    entry: "tests.ts"
  });
}

function fakeProvider(reply: () => string): LlmProvider & { calls: { count: number } } {
  const handle = { count: 0 };
  const provider: LlmProvider & { calls: typeof handle } = {
    name: "fake", modelVersion: "model-fake",
    calls: handle,
    complete: async () => { handle.count += 1; return { text: reply(), usage: { inputTokens: 900, outputTokens: 300 } }; }
  };
  return provider;
}

function targetUnit(repository: PracticeRepository): string {
  const unit = repository.analysis.implementations.find((item) => item.symbol.name === "loadGreeting");
  if (!unit) throw new Error("夹具里找不到 loadGreeting 这个单元");
  return unit.id;
}

describe.skipIf(!capability.usable)("代码题出题自证链", { timeout: 60_000 }, () => {
  it("两跑都成立才落库：题面下发的是缺陷版，判分文件留在引擎缓存里", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const provider = fakeProvider(() => proposalJson({ given: DEFECTIVE_SOURCE, solution: REAL_SOURCE }));

    const exercise = await service.next(repository, { kind: "patch_edit", targetUnitId: targetUnit(repository) }, provider);
    expect(exercise.kind).toBe("patch_edit");
    expect(exercise.inputMode).toBe("code");
    expect(exercise.gradingMode).toBe("execution");
    expect(exercise.family).toBe("code");
    // 下发件是缺陷版；测试与参考解不在 exercise 上。
    expect(exercise.code?.files).toEqual([{ path: "target.ts", contents: DEFECTIVE_SOURCE }]);
    expect(exercise.code?.entry).toBe("tests.ts");
    expect(JSON.stringify(exercise)).not.toContain("TESTS");

    const runs = readJournal(repository.path).filter((event) => event.type === "exercise_run");
    expect(runs.map((event) => [event.payload.label, event.payload.outcome])).toEqual([["solution", "accepted"], ["given", "accepted"]]);
    expect(runs.map((event) => event.payload.verdict_failed)).toEqual([0, 1]);
    expect(readJournal(repository.path).some((event) => event.type === "code_egress" && event.payload.scene === "practice.generate-code")).toBe(true);

    const database = new TutorDatabase(repository.path);
    const stored = database.exercises.byId<{ expected: { type: string; hidden: unknown[]; solution: { contents: string }[] } }>(repository.index.repositoryId, exercise.id);
    database.close();
    expect(stored?.expected.type).toBe("harness");
    expect(stored?.expected.hidden).toEqual([{ path: "tests.ts", contents: TESTS }]);
    expect(stored?.expected.solution[0]?.contents).toBe(REAL_SOURCE);
  });

  it("下发件本身就全过 ⇒ 这道题是白送的，拒掉且两趟运行都留痕", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const provider = fakeProvider(() => proposalJson({ given: REAL_SOURCE, solution: REAL_SOURCE }));
    await expect(service.next(repository, { kind: "patch_edit", targetUnitId: targetUnit(repository) }, provider))
      .rejects.toThrow(/不改也能全过/);
    const runs = readJournal(repository.path).filter((event) => event.type === "exercise_run");
    expect(runs).toHaveLength(2);
    expect(runs.every((event) => event.payload.verdict_failed === 0)).toBe(true);
    const declined = readJournal(repository.path).find((event) => event.type === "exercise_declined");
    expect(declined?.payload.stage).toBe("harness_validation");
  });

  it("下发件靠语法错误「失败」不算自证通过：没印 TESTS 结论就拒，不把编译挂当行为缺陷", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const provider = fakeProvider(() => proposalJson({ given: UNPARSABLE_SOURCE, solution: REAL_SOURCE }));
    await expect(service.next(repository, { kind: "patch_edit", targetUnitId: targetUnit(repository) }, provider))
      .rejects.toThrow(/没收到代码文件|没跑完|跑不出|语法/);
    const declined = readJournal(repository.path).find((event) => event.type === "exercise_declined");
    expect(declined?.payload.stage).toBe("harness_validation");
  });

  it("参考解与仓库真源码逐字对不上 ⇒ 拒（patch_edit 不许把原码改花了还自称原样）", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const drifted = 'export function loadGreeting(environment) {\n  return environment.GREETING ?? "hello";\n}\n';
    const provider = fakeProvider(() => proposalJson({ given: DEFECTIVE_SOURCE, solution: drifted }));
    await expect(service.next(repository, { kind: "patch_edit", targetUnitId: targetUnit(repository) }, provider))
      .rejects.toThrow(/对不上/);
    // 没跑到沙箱：不该有 exercise_run。
    expect(readJournal(repository.path).filter((event) => event.type === "exercise_run")).toHaveLength(0);
  });

  it("没配模型时直接拒，不回落本地题面", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    await expect(service.next(repository, { kind: "patch_edit", targetUnitId: targetUnit(repository) })).rejects.toThrow(/代码题需要模型/);
    expect(readJournal(repository.path).find((event) => event.type === "exercise_declined")?.payload.stage).toBe("no_provider");
  });

  it("同一作用域第二次不再打模型；换 runner 指纹会重出（判分承诺属于那个 runner）", async () => {
    const repository = testRepository();
    const service = new ExerciseService();
    const provider = fakeProvider(() => proposalJson({ given: DEFECTIVE_SOURCE, solution: REAL_SOURCE }));
    const first = await service.next(repository, { kind: "patch_edit", targetUnitId: targetUnit(repository) }, provider);
    const second = await service.next(repository, { kind: "patch_edit", targetUnitId: targetUnit(repository) }, provider);
    expect(second.id).toBe(first.id);
    expect(provider.calls.count).toBe(1);
    // 目标文件内容变了：旧题不复用。
    const bumpedFiles = repository.index.files.map((file) => file.path === "src/config.js" ? { ...file, contentHash: "bumped" } : file);
    const changed = { ...repository, index: { ...repository.index, files: bumpedFiles } };
    const regenerated = await service.next(changed, { kind: "patch_edit", targetUnitId: targetUnit(changed) }, provider);
    expect(regenerated.id).not.toBe(first.id);
    expect(provider.calls.count).toBe(2);
  });
});

describe.skipIf(!capability.usable)("代码题判分", { timeout: 60_000 }, () => {
  async function generatedExercise(): Promise<{ repository: PracticeRepository; service: ExerciseService; exerciseId: string }> {
    const repository = testRepository();
    const service = new ExerciseService();
    const provider = fakeProvider(() => proposalJson({ given: DEFECTIVE_SOURCE, solution: REAL_SOURCE }));
    const exercise = await service.next(repository, { kind: "patch_edit", targetUnitId: targetUnit(repository) }, provider);
    return { repository, service, exerciseId: exercise.id };
  }

  it("返回正确实现 ⇒ 全过、automatic=true、反馈来源标 sandbox（不是 llm_judge）", async () => {
    const { repository, service, exerciseId } = await generatedExercise();
    const result = await service.answer(repository, exerciseId, { files: [{ path: "target.ts", contents: REAL_SOURCE }] });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.automatic).toBe(true);
    expect(result.feedbackSource).toBe("sandbox");
    expect(result.feedback).toContain("测试全过");
    // 判分这一侧不该有模型调用。
    expect(readJournal(repository.path).filter((event) => event.type === "token_usage" && event.payload.scene === "exercise_feedback_polish")).toHaveLength(0);
    const run = readJournal(repository.path).filter((event) => event.type === "exercise_run").at(-1);
    expect(run?.payload.stage).toBe("grade");
    expect(run?.payload.verdict_passed).toBe(2);
    expect(run?.payload.verdict_failed).toBe(0);
  });

  it("只改对一半 ⇒ 分数是通过数除以总断言数，不是「没过就 0 分」", async () => {
    const { repository, service, exerciseId } = await generatedExercise();
    const halfRight = 'export function loadGreeting(environment) {\n  return environment.GREETING ? environment.GREETING : "hallo";\n}\n';
    const result = await service.answer(repository, exerciseId, { files: [{ path: "target.ts", contents: halfRight }] });
    expect(result.passed).toBe(false);
    expect(result.score).toBeCloseTo(0.5, 2);
    expect(result.feedback).toContain("1 过 1 挂");
    // 排期按半对推进，不按零分重置。
    const database = new TutorDatabase(repository.path);
    const schedule = database.reviews.get(repository.index.repositoryId, exerciseId);
    database.close();
    expect(schedule?.exerciseId).toBe(exerciseId);
  });

  it("学习者交的文件名不在下发清单里 ⇒ 当没收到，不拿冻结的缺陷版伪装成他的代码判分", async () => {
    const { repository, service, exerciseId } = await generatedExercise();
    const result = await service.answer(repository, exerciseId, { files: [{ path: "别的.ts", contents: REAL_SOURCE }] });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.feedback).toContain("没收到代码文件");
  });

  it("学习者写坏到没法运行 ⇒ 判未过但如实说「没跑完」，并留一行 no-verdict 的沙箱账", async () => {
    const { repository, service, exerciseId } = await generatedExercise();
    const result = await service.answer(repository, exerciseId, { files: [{ path: "target.ts", contents: UNPARSABLE_SOURCE }] });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.feedback).toContain("测试没能跑完");
    const run = readJournal(repository.path).filter((event) => event.type === "exercise_run").at(-1);
    expect(run?.payload.outcome).toBe("no-verdict");
    expect(run?.payload.verdict_passed).toBe(null);
  });

  it("判分不读仓库源码：把被考文件从盘上删掉，同一份回答照样判得出同样的结论", async () => {
    const { repository, service, exerciseId } = await generatedExercise();
    rmSync(join(repository.path, "src/config.js"));
    const result = await service.answer(repository, exerciseId, { files: [{ path: "target.ts", contents: REAL_SOURCE }] });
    expect(result.passed).toBe(true);
    expect(result.feedbackSource).toBe("sandbox");
  });

  it("老索引出的题，索引后来长出逐文件哈希也不该被永远判过期：兜底档只按全仓比", async () => {
    /** 写侧记 `repo:<versionStamp>` 时，读侧要按同一档回看。 */
    const repository = testRepository();
    const service = new ExerciseService();
    const bare = { ...repository, index: { ...repository.index, files: repository.index.files.map((file) => ({ path: file.path, extension: file.extension, bytes: file.bytes, lines: file.lines })) } };
    const provider = fakeProvider(() => proposalJson({ given: DEFECTIVE_SOURCE, solution: REAL_SOURCE }));
    const exercise = await service.next(bare, { kind: "patch_edit", targetUnitId: targetUnit(bare) }, provider);
    expect(exercise.contentHashes?.[0]?.hash, "无逐文件哈希时应落兜底档").toMatch(/^repo:/);

    // 同一份内容与 versionStamp，索引现在带上逐文件哈希。
    expect(repository.analysis.versionStamp).toBe(bare.analysis.versionStamp);
    const result = await service.answer(repository, exercise.id, { files: [{ path: "target.ts", contents: REAL_SOURCE }] });
    expect(result.passed, JSON.stringify(result.feedback)).toBe(true);
  });
});

describe.skipIf(!capability.usable)("代码题按需讲评", { timeout: 60_000 }, () => {
  async function prepared(explainReply: string) {
    const repository = testRepository();
    const service = new ExerciseService();
    const generate = fakeProvider(() => proposalJson({ given: DEFECTIVE_SOURCE, solution: REAL_SOURCE }));
    const exercise = await service.next(repository, { kind: "patch_edit", targetUnitId: targetUnit(repository) }, generate);
    const explain = fakeProvider(() => explainReply);
    return { repository, service, exercise, explain };
  }

  it("点一次才发这一趟：出网登记走 sandbox-output，账上多一条 exercise_explain", async () => {
    const { repository, service, exercise, explain } = await prepared("空字符串那支断言挂在没走默认值上。");
    expect(readJournal(repository.path).filter((event) => event.type === "token_usage" && event.payload.scene === "exercise_explain")).toHaveLength(0);

    const before = readJournal(repository.path).filter((event) => event.type === "exercise_result").length;
    const result = await service.explain(repository, exercise.id, { files: [{ path: "target.ts", contents: DEFECTIVE_SOURCE }] }, explain);
    expect(result.explanation).toContain("默认值");

    const egress = readJournal(repository.path).filter((event) => event.type === "code_egress" && event.payload.scene === "practice.explain");
    expect(egress.map((event) => [event.payload.kind, event.payload.path])).toEqual([["sandbox-output", "target.ts"]]);
    expect(readJournal(repository.path).filter((event) => event.type === "token_usage" && event.payload.scene === "exercise_explain")).toHaveLength(1);
    // 讲评不改判分：不多 exercise_result，也不回传判分字段。
    expect(readJournal(repository.path).filter((event) => event.type === "exercise_result").length).toBe(before);
    expect(Object.keys(result).sort()).toEqual(["explanation"]);
  });

  it("没配模型就 422 一句话，不回落本地模板", async () => {
    const { repository, service, exercise } = await prepared("不该被用到");
    await expect(service.explain(repository, exercise.id, { files: [{ path: "target.ts", contents: REAL_SOURCE }] }, undefined)).rejects.toThrow("讲评需要模型");
  });

  it("没收到代码就拒：讲评无从说起；非代码题也没有这一趟", async () => {
    const { repository, service, exercise, explain } = await prepared("不该被用到");
    await expect(service.explain(repository, exercise.id, { files: [] }, explain)).rejects.toThrow("没有收到代码");
    const localized = await service.next(repository, { kind: "change_localization" }, explain);
    await expect(service.explain(repository, localized.id, { selectedIds: ["src/config.js"] }, explain)).rejects.toThrow("只有代码题");
  });

  it("学习者粘进口令：出网前被隐去，masked 如实带上（0 与没扫是两个读数）", async () => {
    const { repository, service, exercise, explain } = await prepared("看了就好");
    const withSecret = 'export function loadKey(): string {\n  return "sk-abcdefghijklmnopqrstuvwxyz012345";\n}\n';
    await service.explain(repository, exercise.id, { files: [{ path: "target.ts", contents: withSecret }] }, explain);
    const row = readJournal(repository.path).filter((event) => event.type === "code_egress").at(-1);
    expect(Number(row?.payload.masked)).toBeGreaterThan(0);
    // 文本不落盘；出网行的 chars 是隐去之后那段。
    expect(JSON.stringify(row)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  });
});
