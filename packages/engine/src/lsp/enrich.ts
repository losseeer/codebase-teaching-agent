import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { SymbolInfo } from "@codebase-tutor/shared";
import type { DependencyGraph } from "../depgraph/graph.js";
import { LspClient } from "./client.js";

export async function enrichWithLsp(repositoryPath: string, graph: DependencyGraph): Promise<DependencyGraph> {
  const statuses = graph.lspStatus.map((status) => ({ ...status }));
  const enriched = graph.symbols.map((symbol) => ({ ...symbol }));
  let used = false;
  for (const language of ["typescript", "python"] as const) {
    const index = statuses.findIndex((status) => status.language === language && status.status === "available");
    if (index < 0) continue;
    const relevant = enriched.filter((symbol) => symbol.language === language).slice(0, 80);
    if (!relevant.length) continue;
    const command = language === "typescript" ? "typescript-language-server" : "pylsp";
    const client = new LspClient();
    try {
      await client.start(command, language === "typescript" ? ["--stdio"] : [], pathToFileURL(repositoryPath).href);
      const opened = new Set<string>();
      for (const symbol of relevant) {
        if (!opened.has(symbol.path)) {
          const text = readFileSync(join(repositoryPath, symbol.path), "utf8");
          client.notify("textDocument/didOpen", { textDocument: { uri: pathToFileURL(join(repositoryPath, symbol.path)).href, languageId: language === "typescript" ? "typescript" : "python", version: 1, text } });
          opened.add(symbol.path);
        }
        await enrichSymbol(client, repositoryPath, symbol);
      }
      used = true;
    } catch (error) {
      statuses[index] = { language, status: "fallback", reason: `${command} 初始化失败，已使用静态语法分析：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      client.stop();
    }
  }
  return { ...graph, symbols: enriched, semanticBackend: used ? "lsp" : "static", lspStatus: statuses };
}

async function enrichSymbol(client: LspClient, repositoryPath: string, symbol: SymbolInfo): Promise<void> {
  const source = readFileSync(join(repositoryPath, symbol.path), "utf8").split("\n")[symbol.line - 1] ?? "";
  const character = Math.max(0, source.indexOf(symbol.name));
  const textDocument = { uri: pathToFileURL(join(repositoryPath, symbol.path)).href };
  const position = { line: symbol.line - 1, character };
  const [hover, references] = await Promise.all([
    client.request("textDocument/hover", { textDocument, position }),
    client.request("textDocument/references", { textDocument, position, context: { includeDeclaration: true } })
  ]);
  const contents = (hover as { contents?: unknown } | null)?.contents;
  const text = typeof contents === "string" ? contents : Array.isArray(contents) ? contents.map((item) => typeof item === "string" ? item : (item as { value?: string }).value ?? "").join(" ") : (contents as { value?: string } | undefined)?.value;
  if (text) symbol.type = text.slice(0, 300);
  if (Array.isArray(references)) symbol.referenceCount = references.length;
}
