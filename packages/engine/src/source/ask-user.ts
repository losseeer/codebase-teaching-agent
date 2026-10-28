import type { LlmTool } from "../application/port/llm-provider.js";

/**
  回合内向用户提问：只问本轮上下文里确实没有、又影响答复形状的那一格。
  缺不缺由引擎判定：上下文或请求体已给出的算不缺。
*/
export type AskFacet = "goal" | "range";

/** 校验通过的提问：正文由它拼出，选项随回合一起回给调用方。 */
export interface AskUserAudit {
  facet: AskFacet;
  question: string;
  options: string[];
  /** 待答提问的工具调用 id；认领时用它配对。 */
  toolCallId: string;
}

/** 认领上一回合的提问：挂着的调用 id + 用户选定的那句答句。 */
export interface AskResume {
  toolCallId: string;
  answer: string;
}

/** 一次认领的结果：接上过记 claimed，没接上记 missed。 */
export interface AskClaimAudit {
  toolCallId: string;
  outcome: "claimed" | "missed";
}

const MAX_QUESTION = 40;
const MAX_LABEL = 8;
const MAX_OPTIONS = 4;

/** 工具名；循环按它判分支。 */
export const ASK_USER_TOOL_NAME = "ask_user";

/** 按码点计数，一个汉字算一个。 */
const chars = (text: string): number => [...text].length;

export function askUserToolFor(facets: AskFacet[]): LlmTool {
  return {
    name: ASK_USER_TOOL_NAME,
    description: `本轮缺哪一格就问哪一格（当前缺：${facets.join(" / ")}）。goal=这次到底要产出什么没定；range=范围（画哪几个模块、哪个入口）没定。只在上下文与用户那句话都给不出这一格时才用，能查到的都不许问。question 写一句不超过 ${MAX_QUESTION} 字的人话，options 给 ${MAX_OPTIONS} 个以内的短标签（每个不超过 ${MAX_LABEL} 字）。问句就是本轮的答复：调用它之后本轮不再读文件、不再改图，也不必再写正文。`,
    parameters: {
      type: "object",
      properties: {
        facet: { type: "string", enum: facets.length ? facets : ["goal", "range"], description: "缺的是哪一格。" },
        question: { type: "string", description: `问用户的那一句，不超过 ${MAX_QUESTION} 字。` },
        options: {
          type: "array",
          description: `给用户的候选答案，1–${MAX_OPTIONS} 个，每个不超过 ${MAX_LABEL} 字（用户点了就当下一句话回答）。`,
          items: { type: "string" }
        }
      },
      required: ["facet", "question", "options"]
    }
  };
}

/** 校验一次提问：不合法时回一句给模型看的话，不掀回合。 */
export function parseAsk(argumentsJson: string, allowed: AskFacet[]): { ok: true; ask: Omit<AskUserAudit, "toolCallId"> } | { ok: false; reason: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "ask_user 的参数不是合法 JSON，没法读出问题与选项。" };
  }
  const facet = typeof parsed.facet === "string" ? parsed.facet.trim() : "";
  if (!allowed.includes(facet as AskFacet)) return { ok: false, reason: `本轮能问的只有 ${allowed.join(" / ")}；「${facet || "没填"}」不是其中的一格。缺意图就别问，直接按最贴近的说法作答并写明你的假设。` };
  const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
  if (!question) return { ok: false, reason: "ask_user 缺 question：要问就得给出那一句。" };
  if (chars(question) > MAX_QUESTION) return { ok: false, reason: `问题 ${chars(question)} 字，超过 ${MAX_QUESTION} 字上限：拆短，或改为直接作答并写明假设。` };
  const raw = Array.isArray(parsed.options) ? parsed.options : [];
  if (raw.length < 1) return { ok: false, reason: "ask_user 至少要给一个候选；一个都没有就等于让用户自己猜你要什么。" };
  if (raw.length > MAX_OPTIONS) return { ok: false, reason: `候选 ${raw.length} 个，超过 ${MAX_OPTIONS} 个上限：收最可能的几个。` };
  const options = raw.map((option) => (typeof option === "string" ? option.trim() : "")).filter(Boolean);
  if (options.length !== raw.length) return { ok: false, reason: "候选里混了空值或不是文字的项：每个候选都要是一句短标签。" };
  const over = options.find((option) => chars(option) > MAX_LABEL);
  if (over) return { ok: false, reason: `候选「${over}」${chars(over)} 字，超过 ${MAX_LABEL} 字：按钮放不下，收成短标签（说明写进问题里）。` };
  return { ok: true, ask: { facet: facet as AskFacet, question, options } };
}

/** 由提问拼出本轮正文：问句 + 候选行。 */
export function askBody(ask: AskUserAudit): string {
  return `${ask.question}\n可选项：${ask.options.join(" / ")}`;
}
