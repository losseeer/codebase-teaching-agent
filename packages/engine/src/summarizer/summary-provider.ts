import type { FileRole } from "@codebase-tutor/domain";

import { defineAnalysisStep } from "../analysis-step.js";
import type { LlmProvider, LlmUsage } from "../application/port/llm-provider.js";
import type { FileSlice } from "@codebase-tutor/analysis";

/**
  文件职责摘要（L1）提供方的契约：输入结构切片，输出 SummaryResult。
  批量接口，返回值按下标对齐入参。
  某条为 `undefined` 表示该项没有结果，由调用方补齐。
*/

export interface SummaryResult {
  summary: string;
  /** 模型给出的角色；不在 FILE_ROLES 内时视为没给。 */
  role?: FileRole;
}

export interface SummaryProvider {
  readonly modelVersion: string;
  readonly name: string;
  /** 该档是否把切片内容发到端点。 */
  readonly sendsCodeToEndpoint: boolean;
  summarizeMany(slices: FileSlice[]): Promise<(SummaryResult | undefined)[]>;
  /** 最近一次调用拿到的用量；没调用过为 undefined。 */
  lastUsage?: LlmUsage;
}

/** 一次批量调用的切片条数。 */
export const SUMMARY_BATCH_SIZE = 8;

/** 单条摘要的字符上限。 */
const MAX_SUMMARY_CHARS = 200;
const BATCH_SCENE = "map.summary";

const FILE_ROLES: FileRole[] = ["core", "support", "infra", "tool", "test"];

const ROLE_LABEL: Record<FileRole, string> = {
  core: "执行主干",
  support: "支撑逻辑",
  infra: "设施接入",
  tool: "末端工具",
  test: "测试"
};

const BATCH_SYSTEM_PROMPT_LINES = [
  "下面是一个代码仓库里若干源码文件的**结构切片**：每项含路径、行数、结构角色 role、按重要性排序的符号签名、以及依赖方向。",
  "请为每个文件写一句中文职责摘要（≤60 字），并判断它属于哪一层。",
  "摘要必须至少点出一个切片里**真实出现**的英文标识符（类名、函数名或关键注解即可，不要求默写全部）——只写泛化中文（「负责相关业务处理」）等于没写。",
  "同时尽量带上学习者会用来提问的中文概念词（如 缓存穿透、分布式锁、库存扣减、登录态校验），让「中文问题 ↔ 英文代码」在摘要这一层就对上；概念词以切片事实能支持为限。",
  "只陈述给定信息能支持的事实：不猜测实现细节、不评价代码质量、不编造没出现过的符号名。",
  "role 取值：core（执行主干）、support（支撑逻辑）、infra（配置/存储/日志/网络客户端等设施接入）、tool（末端工具）、test（测试）。切片里已有一个结构规则给出的 role，若你的判断不同，以你的判断为准并写进 role 字段。",
  '严格输出 JSON 数组，长度与输入一致，每项：{"path":"原样返回路径","summary":"…","role":"core|support|infra|tool|test"}。不要输出 JSON 以外的任何文字。'
];

/** 开启「摘要参考注释」时追加的一行提示。 */
const HEADER_COMMENT_PROMPT_LINE = "部分切片可能带 headerComment 字段（文件头注释摘录）：中文概念词可以从中取，但英文标识符仍以符号名为准；注释与符号冲突时以符号为准，勿抄注释里的样板话。";

/** 批量系统提示词。 */
export function batchSystemPrompt(withHeaderComments: boolean): string {
  const lines = [...BATCH_SYSTEM_PROMPT_LINES];
  if (withHeaderComments) lines.splice(4, 0, HEADER_COMMENT_PROMPT_LINE);
  return lines.join("\n");
}

const BATCH_SYSTEM_PROMPT = batchSystemPrompt(false);

/** L1 摘要的口径登记：默认档与参考注释档分属两个契约版本。 */
export const SUMMARY_STEP = defineAnalysisStep({ layer: "summary-slice", contractVersion: "slice-v2", prompts: [batchSystemPrompt(false)] });
export const SUMMARY_COMMENTS_STEP = defineAnalysisStep({ layer: "summary-slice-comments", contractVersion: "slice-v2c", prompts: [batchSystemPrompt(true)] });

/** 解析批量回复并按路径建索引；无法解析时返回空表。 */
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

/** 确定性档：不调用模型，摘要由结构切片拼出。 */
export class LocalSummaryProvider implements SummaryProvider {
  readonly modelVersion = "local-heuristic-v1";
  readonly name = "local deterministic fallback";
  readonly sendsCodeToEndpoint = false;

  /** 确定性档对每一条都给结果。 */
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

/** 轻量档：批量调用，失败项由调用方补齐。 */
export class LlmSummaryProvider implements SummaryProvider {
  readonly name = "light tier LLM";
  readonly sendsCodeToEndpoint = true;

  constructor(private readonly llm: LlmProvider, private readonly withHeaderComments = false) {}

  get modelVersion(): string {
    return this.llm.modelVersion;
  }

  lastUsage?: LlmUsage;

  async summarizeMany(slices: FileSlice[]): Promise<(SummaryResult | undefined)[]> {
    if (!slices.length) return [];
    const response = await this.llm.complete({
      system: batchSystemPrompt(this.withHeaderComments),
      user: JSON.stringify(slices),
      temperature: 0,
      scene: BATCH_SCENE
    });
    this.lastUsage = response.usage;
    const byPath = parseBatchReply(response.text);
    return slices.map((slice) => byPath.get(slice.path));
  }
}

/** 本地 Ollama 档：逐条调用，与批量档共用提示与解析。 */
class OllamaSummaryProvider implements SummaryProvider {
  readonly name = "Ollama local model";
  /** 本机端点同样计入出网。 */
  readonly sendsCodeToEndpoint = true;

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
        results.push(undefined);
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }
}

/** 按 TUTOR_SUMMARY_PROVIDER 选择摘要档。 */
export function createSummaryProvider(input: { llm?: LlmProvider; withHeaderComments?: boolean } = {}): SummaryProvider {
  const mode = (process.env.TUTOR_SUMMARY_PROVIDER ?? "").trim().toLowerCase();
  if (mode === "ollama") return new OllamaSummaryProvider();
  if (mode === "off" || mode === "none" || mode === "local") return new LocalSummaryProvider();
  return input.llm ? new LlmSummaryProvider(input.llm, input.withHeaderComments ?? false) : new LocalSummaryProvider();
}
