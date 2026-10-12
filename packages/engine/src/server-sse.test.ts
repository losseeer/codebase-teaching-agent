import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
  `GET /api/events` 的**真连接**测试（10-12）。

  为什么必须听真 socket：`app.inject()` 把响应整体缓冲到结束才交出来，而这条路由永不结束——
  所以以前它一行测试都没有，也正因如此才没人发现「空转的事件流三秒收 0 字节」：
  只有 writeHead、没有第一帧，响应头就一直压在 Node 的缓冲里。
  本机直连时这只是「看起来连着」，一旦套上反向代理（nginx 默认 60s 空闲就掐上游），
  界面就退回「导入进度停在 0%，任务其实跑完了」那一档。

  零 token：fetch 被 stub 到 127.0.0.1:9（打不到真端点），地址簿、日志、待导入的仓全在临时目录。
  */

const root = realpathSync(mkdtempSync(join(tmpdir(), "tutor-sse-")));
const repoDir = join(root, "repo");
let app: FastifyInstance | undefined;

/** 一条开着的订阅：拿到响应头就算建立，之后每来一帧记一次。 */
interface Stream {
  statusCode: number;
  contentType: string | undefined;
  firstChunk: string;
  /** 首帧之前等了多久（毫秒）——这条断言防的就是「要等第一个事件才拿到响应」 */
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
      // 连接被服务端收尾（撤 key 后事件流就是这么关的）：把已建立的 stream 交回去，别让断言悬着等超时
      response.on("end", () => { if (!settled) { settled = true; resolve(stream); } });
    });
    request.on("error", (error) => { if (!settled) reject(error); settled = true; });
    request.end();
  });
}

/** 等某一帧出现（超时即失败读数，不静默放行）。 */
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
  // 闸门关着（文件不存在）：本文件测的是流的形状，鉴权面在 server-routes.test.ts 那套里测
  process.env.TUTOR_API_KEYS_FILE = join(root, "no-such-keys.json");

  // 必须早于 import server：provider 在构造时就把 fetch 绑成了实例字段
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("测试环境不出网"); }));
  ({ app } = await import("./server.js"));
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllGlobals();
  delete process.env.TUTOR_REGISTRY_FILE;
  delete process.env.TUTOR_LLM_SETTINGS_FILE;
  delete process.env.TUTOR_LLM_LOG;
  delete process.env.TUTOR_ENGINE_LOG;
  delete process.env.TUTOR_API_KEYS_FILE;
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
      // 首帧是注释帧（SSE 解析器跳过，读流循环只认 `data: `）；以前这里要等到第一个导入事件才有字节
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
      // 等 close 事件在引擎侧走完（摘掉订阅者）；摘不摘都不该影响别人，这条断言要的是「另一路照样收」
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
