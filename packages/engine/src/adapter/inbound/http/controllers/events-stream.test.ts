import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
  `GET /api/events` 的测试；路由在 `platform.controller.ts`。
  用真 socket 连接，不用 `app.inject()`。
  */

const root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-sse-")));
const repoDir = join(root, "repo");
let app: FastifyInstance | undefined;

/** 一条已建立的事件流订阅。 */
interface Stream {
  statusCode: number;
  contentType: string | undefined;
  firstChunk: string;
  /** 首帧之前等了多久（毫秒）。 */
  msToFirst: number;
  frames: string[];
  close(): void;
}

function openStream(port: number, path: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const request = httpRequest({ host: "127.0.0.1", port, path }, (response) => {
      const stream: Stream = {
        statusCode: response.statusCode ?? 0,
        contentType: response.headers["content-type"],
        firstChunk: "",
        msToFirst: 0,
        frames: [],
        close: () => request.destroy()
      };
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (!settled) {
          settled = true;
          stream.firstChunk = chunk;
          stream.msToFirst = Date.now() - startedAt;
          resolve(stream);
        }
        stream.frames.push(chunk);
      });
      // 服务端结束连接时也把 stream 交回去。
      response.on("end", () => { if (!settled) { settled = true; resolve(stream); } });
    });
    request.on("error", (error) => { if (!settled) reject(error); settled = true; });
    request.end();
  });
}

/** 等某一帧出现；超时返回 `undefined`。 */
async function waitForFrame(stream: Stream, predicate: (frame: string) => boolean, timeoutMs = 8_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = stream.frames.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

beforeAll(async () => {
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "main.ts"), "export function ping(): number { return 1; }\n", "utf8");
  writeFileSync(join(repoDir, "README.md"), "# fixture\n", "utf8");

  process.env.TUTOR_REGISTRY_FILE = join(root, "registry.json");
  writeFileSync(process.env.TUTOR_REGISTRY_FILE, '{ "repositories": [] }\n', "utf8");
  process.env.TUTOR_LLM_SETTINGS_FILE = join(root, "llm-settings.json");
  writeFileSync(process.env.TUTOR_LLM_SETTINGS_FILE, JSON.stringify({ provider: "openai-compatible", model: "fixture-model", baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-key", thinking: "auto" }), "utf8");
  process.env.TUTOR_LLM_LOG = join(root, "llm.log");
  process.env.TUTOR_ENGINE_LOG = "off";

  // 必须早于 import server：provider 构造时就把 fetch 绑成实例字段。
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("测试环境不出网"); }));
  ({ app } = await import("../../../../server.js"));
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  delete process.env.TUTOR_REGISTRY_FILE;
  delete process.env.TUTOR_LLM_SETTINGS_FILE;
  delete process.env.TUTOR_LLM_LOG;
  delete process.env.TUTOR_ENGINE_LOG;
  rmSync(root, { recursive: true, force: true });
});

function port(): number {
  const address = app?.server.address();
  if (!address || typeof address === "string") throw new Error("测试引擎没听端口");
  return address.port;
}

describe("全局事件流的真连接", () => {
  it("建立即落网：不等任何事件就拿到响应头与首帧", async () => {
    const stream = await openStream(port(), "/api/events");
    try {
      expect(stream.statusCode).toBe(200);
      expect(stream.contentType).toContain("text/event-stream");
      // 首帧是注释帧。
      expect(stream.firstChunk).toBe(": open\n\n");
      expect(stream.msToFirst).toBeLessThan(1_000);
    } finally {
      stream.close();
    }
  });

  it("导入进度推得到：一帧一帧的 data，且带得出 job id", async () => {
    const stream = await openStream(port(), "/api/events");
    try {
      const submitted = await app!.inject({ method: "POST", url: "/api/imports", payload: { path: repoDir } });
      expect(submitted.statusCode).toBe(202);
      const jobId = (submitted.json() as { id: string }).id;
      const frame = await waitForFrame(stream, (chunk) => chunk.includes("data: ") && chunk.includes(jobId));
      expect(frame, `没收到 job ${jobId} 的进度帧`).toContain("import.progress");
    } finally {
      stream.close();
    }
  });

  it("一路订阅者硬断，不影响另一路收帧", async () => {
    const dead = await openStream(port(), "/api/events");
    const alive = await openStream(port(), "/api/events");
    try {
      dead.close();
      // 等引擎侧 close 事件走完（订阅者移除）再提交。
      await new Promise((resolve) => setTimeout(resolve, 150));
      const submitted = await app!.inject({ method: "POST", url: "/api/imports", payload: { path: repoDir } });
      const jobId = (submitted.json() as { id: string }).id;
      const frame = await waitForFrame(alive, (chunk) => chunk.includes("data: ") && chunk.includes(jobId));
      expect(frame, "死掉的那一路把广播弄断了").toContain("import.progress");
    } finally {
      alive.close();
    }
  });
});
