export interface SummaryProvider {
  readonly modelVersion: string;
  readonly name: string;
  summarize(input: { path: string; content: string }): Promise<string>;
}

/** Deterministic Phase 0 provider. It keeps imports/tests reproducible without an API key. */
export class LocalSummaryProvider implements SummaryProvider {
  readonly modelVersion = "local-heuristic-v1";
  readonly name = "local deterministic fallback";

  async summarize({ path, content }: { path: string; content: string }): Promise<string> {
    const lines = content.split("\n");
    const imports = lines.filter((line) => /^\s*(import|from|require\()/.test(line)).length;
    const symbols = lines
      .map((line) => line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_$][\w$]*)/)?.[1])
      .filter((symbol): symbol is string => Boolean(symbol))
      .slice(0, 5);
    const role = symbols.length ? `定义 ${symbols.join("、")}` : "承载配置或内容";
    return `${path} 共 ${lines.length} 行，${role}${imports ? `，并连接 ${imports} 个导入语句` : ""}。`;
  }
}

export class OllamaSummaryProvider implements SummaryProvider {
  readonly name = "Ollama local model";

  constructor(private readonly model = process.env.TUTOR_OLLAMA_MODEL ?? "llama3.2", private readonly endpoint = process.env.TUTOR_OLLAMA_URL ?? "http://127.0.0.1:11434") {}

  get modelVersion(): string {
    return `ollama:${this.model}`;
  }

  async summarize({ path, content }: { path: string; content: string }): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model: this.model, stream: false, options: { temperature: 0 }, prompt: `用不超过两句中文准确概括下面的代码文件；只陈述源码可证实的事实。文件：${path}\n\n${content.slice(0, 20_000)}` })
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const body = await response.json() as { response?: string };
      if (!body.response?.trim()) throw new Error("Ollama returned an empty summary");
      return body.response.trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Routes only when explicitly requested. Any local-model failure immediately falls back per file. */
export class FailoverSummaryProvider implements SummaryProvider {
  readonly name: string;
  readonly modelVersion: string;

  constructor(private readonly primary: SummaryProvider, private readonly fallback = new LocalSummaryProvider()) {
    this.name = `${primary.name} with deterministic fallback`;
    this.modelVersion = `${primary.modelVersion}|${fallback.modelVersion}`;
  }

  async summarize(input: { path: string; content: string }): Promise<string> {
    try {
      return await this.primary.summarize(input);
    } catch {
      return this.fallback.summarize(input);
    }
  }
}

export function createSummaryProvider(): SummaryProvider {
  return process.env.TUTOR_SUMMARY_PROVIDER === "ollama" ? new FailoverSummaryProvider(new OllamaSummaryProvider()) : new LocalSummaryProvider();
}
