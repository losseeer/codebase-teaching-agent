/**
  Baseline 执行器：读 manifest / topics.csv / conversation-questions.csv，按任务串行跑。
  依赖一个独立引擎进程（TUTOR_BASELINE_ENGINE，默认 http://127.0.0.1:3001）。
  用法：
    pnpm experiment:baseline --dry
    pnpm experiment:baseline --phase=exercises
    pnpm experiment:baseline --phase=conversation
    pnpm experiment:baseline --task=<taskId>
*/
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../../..");
const manifestPath = join(root, "experiments/baseline/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const engine = (process.env.TUTOR_BASELINE_ENGINE ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const phase = args.find((arg) => arg.startsWith("--phase="))?.split("=")[1];
const taskFilter = args.find((arg) => arg.startsWith("--task="))?.slice("--task=".length);
const sessionFilter = args.find((arg) => arg.startsWith("--session="))?.slice("--session=".length);
const outArg = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
const fromArg = args.find((arg) => arg.startsWith("--from="))?.slice("--from=".length);
const fromIndex = fromArg ? Math.max(0, Number(fromArg)) : 0;
const outputPath = (fallback: string): string => outArg ? resolve(root, outArg) : join(root, fallback);
const runId = process.env.BASELINE_RUN_ID ?? new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
const nonceBase = Number(process.env.BASELINE_NONCE_BASE ?? String(Date.now() % 1_000_000_000));

interface Manifest {
  experimentId: string;
  model: { provider: string; name: string; timeoutMs: number; thinking: string; promptVersion: string; summaryProvider?: string };
  repos: { name: string; language: string; sourcePath: string; path: string; commit: string; license: string; design: boolean; status: string }[];
  inputs: { conversationQuestions: string; topics: string };
  outputs: { conversation: string; exercises: string; practiceExercises: string; summary: string };
  rules: { generationFirst: boolean; variantNonce: string; maxAttemptsPerTask: number; includeCacheHits: boolean };
}

interface TopicRow { repo: string; type: "comprehension" | "analysis" | "design"; topic: string; tag_id: string; note: string }
interface QuestionRow { repo: string; scene: "teaching" | "map" | "practice"; session_id: string; scope_ref: string; turn_index: string; question: string; exercise_ref: string }

function csv(path: string): Record<string, string>[] {
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const header = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
  });
}

function tasks(): { exercises: TopicRow[]; questions: QuestionRow[] } {
  return { exercises: csv(join(root, manifest.inputs.topics)) as unknown as TopicRow[], questions: csv(join(root, manifest.inputs.conversationQuestions)) as unknown as QuestionRow[] };
}

function assertInputs(): void {
  const { exercises, questions } = tasks();
  const problems: string[] = [];
  if (manifest.repos.length !== 6) problems.push(`仓库数 ${manifest.repos.length} ≠ 6`);
  for (const repo of manifest.repos) {
    if (repo.status !== "ready") problems.push(`${repo.name} 状态 ${repo.status}`);
    if (!repo.path || !existsSync(join(root, repo.path))) problems.push(`${repo.name} 副本不存在：${repo.path}`);
    if (!repo.commit) problems.push(`${repo.name} 缺提交哈希`);
  }
  if (exercises.length !== 90) problems.push(`主题 ${exercises.length} 行 ≠ 90`);
  if (questions.length !== 216) problems.push(`对话问题 ${questions.length} 条 ≠ 216`);
  const sessions = new Set(questions.map((row) => `${row.repo}:${row.session_id}`));
  if (sessions.size !== 36) problems.push(`会话 ${sessions.size} 个 ≠ 36`);
  if (problems.length) throw new Error(`输入未冻结：\n- ${problems.join("\n- ")}`);
}

function taskId(row: TopicRow | QuestionRow, kind: "exercise" | "conversation"): string {
  if (kind === "exercise") {
    const topic = row as TopicRow;
    return `exercise:${topic.repo}:${topic.type}:${topic.tag_id}`;
  }
  const question = row as QuestionRow;
  return `conversation:${question.repo}:${question.session_id}:${question.turn_index}`;
}

function repoIdByName(entry: Record<string, unknown>, name: string): string | undefined {
  const repos = entry.repositories as { repositoryId: string; repositoryPath: string }[];
  const target = resolve(join(root, manifest.repos.find((repo) => repo.name === name)!.path));
  return repos.find((repo) => resolve(repo.repositoryPath) === target)?.repositoryId;
}

async function catalog(): Promise<Record<string, unknown>> {
  const response = await fetch(`${engine}/api/repositories`);
  if (!response.ok) throw new Error(`读仓库地址簿失败：HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

function usage(traceId: string | null): { input_tokens?: number; output_tokens?: number } {
  if (!traceId) return {};
  const file = process.env.TUTOR_LLM_LOG ?? join(homedir(), ".codebase-tutor", "llm.log");
  if (!existsSync(file)) return {};
  let input = 0;
  let output = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as { traceId?: string; inputTokens?: number; outputTokens?: number };
      if (row.traceId !== traceId) continue;
      input += row.inputTokens ?? 0;
      output += row.outputTokens ?? 0;
    } catch { /* 坏行跳过 */ }
  }
  return { input_tokens: input, output_tokens: output };
}

function journalFacts(repoName: string, traceId: string | null): { generation_source?: string; failure_stage?: string } {
  if (!traceId) return {};
  const repo = manifest.repos.find((item) => item.name === repoName);
  const file = repo ? join(root, repo.path, ".tutor", "journal.jsonl") : "";
  if (!file || !existsSync(file)) return {};
  let source: string | undefined;
  let stage: string | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as { type?: string; traceId?: string | null; payload?: Record<string, unknown> };
      if (event.traceId !== traceId) continue;
      if (event.type === "exercise_generated" && typeof event.payload?.source === "string") source = event.payload.source;
      if (event.type === "exercise_declined" && typeof event.payload?.stage === "string") stage = event.payload.stage;
    } catch { /* 坏行跳过 */ }
  }
  return { ...(source ? { generation_source: source } : {}), ...(stage ? { failure_stage: stage } : {}) };
}

/** 出题是长请求（多次模型调用 + 沙箱自证），Node fetch 的 300s headersTimeout 太短；用 http 直连。 */
function postJson(url: string, payload: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: { id?: string; error?: string; code?: string } }> {
  const target = new URL(url);
  const body = JSON.stringify(payload);
  const lib = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = lib.request(target, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => {
        let parsed: { id?: string; error?: string; code?: string };
        try { parsed = JSON.parse(text) as typeof parsed; } catch { parsed = { error: text }; }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: parsed });
      });
    });
    request.setTimeout(1_800_000, () => request.destroy(new Error("出题任务超过 1800s")));
    request.on("error", reject);
    request.end(body);
  });
}

async function runExercise(row: TopicRow, index: number, known: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repositoryId = repoIdByName(known, row.repo);
  if (!repositoryId) throw new Error(`${row.repo} 不在引擎地址簿里；先导入 ${row.repo}`);
  const started = new Date();
  let response: { status: number; headers: http.IncomingHttpHeaders; body: { id?: string; error?: string } } | undefined;
  let requestError: string | undefined;
  try {
    response = await postJson(`${engine}/api/repositories/${repositoryId}/exercises`, { type: row.type, tag: row.topic, tagId: row.tag_id, variantNonce: nonceBase + index });
  } catch (error) {
    // 单任务超时/断连只记这一条失败，不掀翻整轮
    requestError = error instanceof Error ? error.message : String(error);
  }
  const traceId = response && typeof response.headers["x-trace-id"] === "string" ? response.headers["x-trace-id"] : null;
  const body = response?.body ?? {};
  const ended = new Date();
  const facts = journalFacts(row.repo, traceId);
  // 客户端先超时：引擎侧没有留下可关联的 journal 行，按超时计失败。
  const failureStage = facts.failure_stage ?? (requestError?.includes("超过") ? "timeout" : requestError ? "request_error" : undefined);
  return {
    taskId: taskId(row, "exercise"), experimentId: manifest.experimentId, runId, repo: row.repo,
    language: manifest.repos.find((repo) => repo.name === row.repo)?.language, type: row.type, topic: row.topic,
    started_at: started.toISOString(), ended_at: ended.toISOString(), duration_ms: ended.getTime() - started.getTime(),
    traceId, success: Boolean(response) && response!.status >= 200 && response!.status < 300, ...(body.id ? { exerciseId: body.id } : {}),
    ...(facts.generation_source ? { generation_source: facts.generation_source, cache_hit: facts.generation_source === "cache" } : {}),
    ...(failureStage ? { failure_stage: failureStage } : {}),
    ...(body.error ? { error: body.error } : {}),
    ...(requestError ? { error: requestError } : {}),
    ...usage(traceId)
  };
}

async function sse(url: string, payload: unknown, traceIdRef: { value?: string | null }, method = "POST", headers: Record<string, string> = { "content-type": "application/json" }): Promise<{ done?: Record<string, unknown>; error?: string }> {
  const response = await fetch(url, { method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  traceIdRef.value = response.headers.get("x-trace-id");
  const text = await response.text();
  let done: Record<string, unknown> | undefined;
  let error: string | undefined;
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((item) => item.startsWith("data: "));
    if (!line) continue;
    try {
      const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
      if (event.type === "done") done = event;
      if (event.type === "error") error = String(event.error ?? "对话失败");
    } catch { /* 坏帧跳过 */ }
  }
  return { ...(done ? { done } : {}), ...(error ? { error } : {}) };
}

async function createThread(repositoryId: string, scope: "map" | "practice", title: string, exerciseId?: string): Promise<string> {
  const response = await fetch(`${engine}/api/repositories/${repositoryId}/threads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope, title, ...(exerciseId ? { exerciseId } : {}) })
  });
  if (!response.ok) throw new Error(`创建 ${scope} 线程失败：HTTP ${response.status}`);
  return (await response.json() as { thread: { id: string } }).thread.id;
}

const teachingSessions = new Map<string, string>();
const threads = new Map<string, string>();

async function runQuestion(row: QuestionRow, known: Record<string, unknown>): Promise<Record<string, unknown>> {
  const repo = manifest.repos.find((item) => item.name === row.repo)!;
  const repositoryId = repoIdByName(known, row.repo);
  if (!repositoryId) throw new Error(`${row.repo} 不在引擎地址簿里；先导入 ${row.repo}`);
  const practiceFile = join(root, manifest.outputs.practiceExercises);
  const practice = existsSync(practiceFile) ? (JSON.parse(readFileSync(practiceFile, "utf8")) as Record<string, { exerciseId?: string; status?: string }>)[row.repo] : undefined;
  if (row.scene === "practice" && (!practice?.exerciseId || practice.status === "not_applicable")) {
    return { taskId: taskId(row, "conversation"), experimentId: manifest.experimentId, repo: row.repo, scene: row.scene, session_id: row.session_id, turn_index: Number(row.turn_index), success: false, not_applicable: "没有可用练习固定题" };
  }
  const started = new Date();
  const trace = { value: undefined as string | null | undefined };
  let done: Record<string, unknown> | undefined;
  let error: string | undefined;
  if (row.scene === "teaching") {
    const key = `${row.repo}:${row.session_id}`;
    let sessionId = teachingSessions.get(key);
    if (!sessionId) {
      const session = await fetch(`${engine}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryId, scopeRef: row.scope_ref }) });
      if (!session.ok) throw new Error(`创建教学会话失败：HTTP ${session.status}`);
      sessionId = (await session.json() as { session: { id: string } }).session.id;
      teachingSessions.set(key, sessionId);
    }
    const result = await sse(`${engine}/api/sessions/${sessionId}/messages`, { content: row.question }, trace);
    done = result.done; error = result.error;
  } else if (row.scene === "map") {
    const key = `${row.repo}:${row.session_id}`;
    let threadId = threads.get(key);
    if (!threadId) {
      threadId = await createThread(repositoryId, "map", row.session_id);
      threads.set(key, threadId);
    }
    const path = row.scope_ref.replace(/^dir:/, "");
    const result = await sse(`${engine}/api/repositories/${repositoryId}/map-chat/stream`, { content: row.question, path, threadId }, trace);
    done = result.done; error = result.error;
  } else {
    const key = `${row.repo}:${row.session_id}`;
    let threadId = threads.get(key);
    if (!threadId) {
      threadId = await createThread(repositoryId, "practice", row.session_id, practice!.exerciseId);
      threads.set(key, threadId);
    }
    const result = await sse(`${engine}/api/repositories/${repositoryId}/practice-chat`, { content: row.question, exerciseId: practice!.exerciseId, threadId }, trace);
    done = result.done; error = result.error;
  }
  const ended = new Date();
  return {
    taskId: taskId(row, "conversation"), experimentId: manifest.experimentId, runId, repo: row.repo, scene: row.scene,
    session_id: row.session_id, turn_index: Number(row.turn_index), started_at: started.toISOString(),
    ended_at: ended.toISOString(), duration_ms: ended.getTime() - started.getTime(), traceId: trace.value,
    success: Boolean(done) && !error, ...(done?.provider ? { provider: done.provider } : {}),
    ...(done?.cost ? { cost: done.cost } : {}), ...(error ? { error } : {}), ...usage(trace.value ?? null)
  };
}

function output(rows: Record<string, unknown>[], target: string, append: boolean): void {
  mkdirSync(dirname(target), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
  if (append && existsSync(target)) appendFileSync(target, text);
  else writeFileSync(target, text);
}

async function main(): Promise<void> {
  assertInputs();
  const { exercises, questions } = tasks();
  if (dry) {
    console.log(`experiment=${manifest.experimentId} repos=6 topics=${exercises.length} questions=${questions.length} sessions=${new Set(questions.map((row) => `${row.repo}:${row.session_id}`)).size}`);
    console.log(`engine=${engine} model=${manifest.model.name} timeout=${manifest.model.timeoutMs}ms`);
    console.log(`tasks exercise=${exercises.length} conversation=${questions.length}`);
    return;
  }
  if (taskFilter?.startsWith("exercise:")) {
    const row = exercises.find((item) => taskId(item, "exercise") === taskFilter);
    if (!row) throw new Error(`找不到任务 ${taskFilter}`);
    output([await runExercise(row, exercises.indexOf(row), await catalog())], outputPath(manifest.outputs.exercises), true);
    return;
  }
  if (taskFilter?.startsWith("conversation:")) {
    const row = questions.find((item) => taskId(item, "conversation") === taskFilter);
    if (!row) throw new Error(`找不到任务 ${taskFilter}`);
    output([await runQuestion(row, await catalog())], outputPath(manifest.outputs.conversation), !outArg);
    return;
  }
  if (sessionFilter) {
    const rows = questions.filter((row) => `${row.repo}:${row.session_id}` === sessionFilter);
    if (!rows.length) throw new Error(`找不到会话 ${sessionFilter}`);
    const known = await catalog();
    const target = outputPath(manifest.outputs.conversation);
    writeFileSync(target, "");
    for (const row of rows) output([await runQuestion(row, known)], target, true);
    return;
  }
  if (phase === "exercises") {
    const known = await catalog();
    const target = outputPath(manifest.outputs.exercises);
    // `--from` 续跑：保留已有行，只从第 N 个任务往后追加。
    if (!fromIndex) writeFileSync(target, "");
    for (const [index, row] of exercises.entries()) {
      if (index < fromIndex) continue;
      output([await runExercise(row, index, known)], target, true);
    }
    return;
  }
  if (phase === "conversation") {
    const known = await catalog();
    const target = outputPath(manifest.outputs.conversation);
    writeFileSync(target, "");
    for (const row of questions) output([await runQuestion(row, known)], target, true);
    return;
  }
  throw new Error("用法：--dry | --phase=exercises | --phase=conversation | --session=<repo:session> | --task=<taskId>");
}

await main();
