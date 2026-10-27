import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type JsonRpcMessage = { id?: number; method?: string; result?: unknown; error?: { message?: string } };

/** Small JSON-RPC transport for local stdio language servers. */
export class LspClient {
  private process?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  async start(command: string, args: string[], rootUri: string): Promise<void> {
    this.process = spawn(command, args, { stdio: "pipe" });
    this.process.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.process.on("error", (error) => this.rejectAll(error));
    this.process.on("exit", () => this.rejectAll(new Error("language server exited")));
    await this.request("initialize", { processId: process.pid, rootUri, capabilities: { textDocument: { hover: {}, references: {} } }, workspaceFolders: [{ uri: rootUri, name: "repository" }] }, 2_000);
    this.notify("initialized", {});
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, timeoutMs = 1_500): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  stop(): void {
    this.rejectAll(new Error("language server stopped"));
    this.process?.kill();
    this.process = undefined;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.process?.stdin.writable) throw new Error("LSP process is not available");
    const body = JSON.stringify(message);
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const marker = this.buffer.indexOf("\r\n\r\n");
      if (marker < 0) return;
      const header = this.buffer.subarray(0, marker).toString("utf8");
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isFinite(length) || this.buffer.length < marker + 4 + length) return;
      const body = this.buffer.subarray(marker + 4, marker + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(marker + 4 + length);
      try { this.handle(JSON.parse(body) as JsonRpcMessage); } catch { /* Ignore malformed server output. */ }
    }
  }

  private handle(message: JsonRpcMessage): void {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "LSP request failed"));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
