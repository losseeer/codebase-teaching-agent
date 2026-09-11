export interface GroundingRubricInput {
  excerpts: string[];
  rationale: string;
  hasSelectedEvidence: boolean;
}

export interface GroundingRubricScore {
  score: number;
  feedback: string;
}

/**
 * Optional local-model judge for the qualitative grounding criterion. Structural
 * evidence matching remains deterministic, and every failure falls back locally.
 */
export async function scoreGrounding(input: GroundingRubricInput): Promise<GroundingRubricScore> {
  const fallback = deterministicGrounding(input);
  if (process.env.TUTOR_RUBRIC_PROVIDER !== "ollama" || !input.hasSelectedEvidence || !input.rationale.trim()) return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${process.env.TUTOR_OLLAMA_URL ?? "http://127.0.0.1:11434"}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.TUTOR_OLLAMA_MODEL ?? "llama3.2",
        stream: false,
        options: { temperature: 0 },
        prompt: `你是代码证据评分器。仅根据给出的证据，判断学习者理由是否引用并且没有超出证据范围。返回 JSON：{"score":0到1的小数,"feedback":"不超过一句中文"}。\n证据：${input.excerpts.join("\n")}\n学习者理由：${input.rationale}`
      })
    });
    if (!response.ok) return fallback;
    const body = await response.json() as { response?: string };
    const match = body.response?.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]) as { score?: unknown; feedback?: unknown };
    if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score)) return fallback;
    return { score: Math.max(0, Math.min(0.2, parsed.score * 0.2)), feedback: typeof parsed.feedback === "string" ? parsed.feedback.slice(0, 180) : fallback.feedback };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function deterministicGrounding(input: GroundingRubricInput): GroundingRubricScore {
  const tokens = input.excerpts.flatMap((excerpt) => excerpt.split(/[^A-Za-z0-9_$\u4e00-\u9fff]+/).filter((word) => word.length >= 2));
  const matched = input.hasSelectedEvidence && tokens.some((word) => input.rationale.includes(word));
  return { score: matched ? 0.2 : 0, feedback: matched ? "辩护引用了证据中的具体信息。" : "请在理由中引用所选证据的具体信息。" };
}
