import type { FileRole } from "@codebase-tutor/shared";
import type { LlmProvider } from "../llm/provider.js";
import type { FileSlice } from "./slice.js";

/**
  文件职责摘要的提供方（L1）。

  契约自 2026-09-18 起：
  - **输入**是**结构切片**（`FileSlice`），不是整份正文。正文既贵又噪，切片只留按重要性排过序的
    符号签名与依赖方向。
  - **输出**是 `{summary, role?}`；角色本由结构规则给出（`depgraph/roles.ts`），模型给的角色是
    **可选覆盖**——给了就用，没给就沿用结构结论。
  - 接口是**批量**的：一次调用处理多条切片。逐文件一次调用在导入期会串行几百次（300 文件 ≈ 300 次
    往返），批量化把往返次数降到 1/8，且重复的系统提示只付一次。
  - 返回值**按下标对齐**入参，某一条 `undefined` 表示没拿到结果、由调用方回落——不用异常表达
    「部分失败」，因为批量里坏一条不该丢掉另外七条。
*/

export interface SummaryResult {
  summary: string;
  /** 模型给出的角色；不是那五个之一时视为没给。 */
  role?: FileRole;
}

export interface SummaryProvider {
  readonly modelVersion: string;
  readonly name: string;
  summarizeMany(slices: FileSlice[]): Promise<(SummaryResult | undefined)[]>;
}

/** 一次调用塞几条切片：太多则单次失败牵连面大，太少则往返次数又上去了。 */
export const SUMMARY_BATCH_SIZE = 8;

/** 约束回复长度：摘要会进课程树、再被 `llm-refine` 整份送去润色，长了就是长尾成本。 */
const MAX_SUMMARY_CHARS = 200;
const BATCH_MAX_TOKENS = 1_200;
const BATCH_SCENE = "map.summary";

const FILE_ROLES: FileRole[] = ["core", "support", "infra", "tool", "test"];

const ROLE_LABEL: Record<FileRole, string> = {
  core: "执行主干",
  support: "支撑逻辑",
  infra: "设施接入",
  tool: "末端工具",
  test: "测试"
};

const BATCH_SYSTEM_PROMPT = [
  "下面是一个代码仓库里若干源码文件的**结构切片**：每项含路径、行数、结构角色 role、按重要性排序的符号签名、以及依赖方向。",
  "请为每个文件写一句中文职责摘要（≤60 字），并判断它属于哪一层。",
  "只陈述给定信息能支持的事实：不猜测实现细节、不评价代码质量、不编造没出现过的符号名。",
  "role 取值：core（执行主干）、support（支撑逻辑）、infra（配置/存储/日志/网络客户端等设施接入）、tool（末端工具）、test（测试）。切片里已有一个结构规则给出的 role，若你的判断不同，以你的判断为准并写进 role 字段。",
  '严格输出 JSON 数组，长度与输入一致，每项：{"path":"原样返回路径","summary":"…","role":"core|support|infra|tool|test"}。不要输出 JSON 以外的任何文字。'
].join("\n");

/**
  解析批量回复：按路径建索引（不按下标硬对，模型偶尔会漏项或换序）。
  读不出的项直接不返回，由调用方按「这一条没拿到结果」回落；解析整体失败返回空表。
  单独导出是为了能直接测这段容错，而不是只能靠桩服务绕一圈。
*/
export function parseBatchReply(text: string): Map<string, SummaryResult> {
  const results = new Map<string, SummaryResult>();
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) return results;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return results;
  }
  if (!Array.isArray(parsed)) return results;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as { path?: unknown; summary?: unknown; role?: unknown };
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const summary = typeof record.summary === "string" ? record.summary.trim().replace(/\s+/g, " ").slice(0, MAX_SUMMARY_CHARS) : "";
    if (!path || !summary) continue;
    const role = typeof record.role === "string" && (FILE_ROLES as string[]).includes(record.role) ? record.role as FileRole : undefined;
    results.set(path, role ? { summary, role } : { summary });
  }
  return results;
}

/**
  确定性兜底：不调模型，摘要完全由结构切片拼出（离线可复现、不烧 token）。

  ⚠️ 摘要要**短**：它进课程树当节点摘要，而 `coursetree/llm-refine.ts` 会把节点摘要整份送去润色。
  这里放长一句，每次润色就多付一次钱。详细信息由切片承载（那是喂给模型的），摘要只说
  「属于哪层 + 认出哪些主要符号」。
*/
export class LocalSummaryProvider implements SummaryProvider {
  readonly modelVersion = "local-heuristic-v1";
  readonly name = "local deterministic fallback";

  /** 契约比接口更紧：确定性档对**每一条**都给结果（调用方据此把它当补齐手段）。 */
  async summarizeMany(slices: FileSlice[]): Promise<SummaryResult[]> {
    return slices.map((slice) => {
      const names = slice.entries.slice(0, 3).map((entry) => entry.name);
      const total = slice.entries.length + slice.omittedSymbols;
      const detail = names.length
        ? `定义 ${names.join("、")}${total > names.length ? ` 等 ${total} 个符号` : ""}`
        : "未识别到函数或类定义";
      return { summary: `${slice.path}：${ROLE_LABEL[slice.role]}；${detail}` };
    });
  }
}

/** 走项目自己的**轻量档**（L1 的语义来源）。批量调用，单次失败由调用方按条回落。 */
export class LlmSummaryProvider implements SummaryProvider {
  readonly name = "light tier LLM";

  constructor(private readonly llm: LlmProvider) {}

  get modelVersion(): string {
    return this.llm.modelVersion;
  }

  async summarizeMany(slices: FileSlice[]): Promise<(SummaryResult | undefined)[]> {
    if (!slices.length) return [];
    const response = await this.llm.complete({
      system: BATCH_SYSTEM_PROMPT,
      user: JSON.stringify(slices),
      maxTokens: BATCH_MAX_TOKENS,
      temperature: 0,
      scene: BATCH_SCENE
    });
    const byPath = parseBatchReply(response.text);
    return slices.map((slice) => byPath.get(slice.path));
  }
}

/** 本地 Ollama（`TUTOR_SUMMARY_PROVIDER=ollama` 时启用）：逐条调用，与批量档共用同一套提示与解析。 */
export class OllamaSummaryProvider implements SummaryProvider {
  readonly name = "Ollama local model";

  constructor(private readonly model = process.env.TUTOR_OLLAMA_MODEL ?? "llama3.2", private readonly endpoint = process.env.TUTOR_OLLAMA_URL ?? "http://127.0.0.1:11434") {}

  get modelVersion(): string {
    return `ollama:${this.model}`;
  }

  async summarizeMany(slices: FileSlice[]): Promise<(SummaryResult | undefined)[]> {
    const results: (SummaryResult | undefined)[] = [];
    for (const slice of slices) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetch(`${this.endpoint}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ model: this.model, stream: false, options: { temperature: 0 }, prompt: `${BATCH_SYSTEM_PROMPT}\n\n${JSON.stringify([slice])}` })
        });
        if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
        const body = await response.json() as { response?: string };
        results.push(body.response?.trim() ? parseBatchReply(body.response).get(slice.path) : undefined);
      } catch {
        // 本地模型不可用就这一条没结果，由调用方回落；不因为一条坏掉中断整批
        results.push(undefined);
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }
}

/**
  选择摘要档：

  - `TUTOR_SUMMARY_PROVIDER=ollama` → 本地 Ollama
  - `TUTOR_SUMMARY_PROVIDER=off|none|local` → 确定性档（不调模型的显式开关）
  - 未设置（默认）→ **有轻量档就用轻量档**，没有就退确定性档

  默认值是有意选的：L1 的价值就在「语义摘要」，默认不烧 token 等于这个能力永远不生效。
  但要能一键关掉，所以留了 `off`；费用闸门在调用方（预算降级时传不进 llm）。
*/
export function createSummaryProvider(input: { llm?: LlmProvider } = {}): SummaryProvider {
  const mode = (process.env.TUTOR_SUMMARY_PROVIDER ?? "").trim().toLowerCase();
  if (mode === "ollama") return new OllamaSummaryProvider();
  if (mode === "off" || mode === "none" || mode === "local") return new LocalSummaryProvider();
  return input.llm ? new LlmSummaryProvider(input.llm) : new LocalSummaryProvider();
}
