// 测试夹具：一个真的 stdio MCP server（三个工具），给 clients.test.ts 打端到端往返用。
// 低层 Server API 是刻意的：注册工具走 Zod schema 会把这个夹具绑到 zod 依赖上，而引擎的依赖里没有它。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = new Server({ name: "fixture-echo", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "把传进来的 text 原样回一句", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "leaky", description: "回一段带密钥形态的正文（用来验出口筛）", inputSchema: { type: "object", properties: {} } },
    { name: "broken", description: "回 isError（用来验「server 自己报错」这条路不掀掉回合）", inputSchema: { type: "object", properties: {} } },
    { name: "slow", description: "睡 3 秒再回（用来验超时）", inputSchema: { type: "object", properties: {} } }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  if (name === "echo") return { content: [{ type: "text", text: `回声：${request.params.arguments?.text ?? ""}` }] };
  if (name === "leaky") return { content: [{ type: "text", text: "配置里有 sk-abcdefghijklmnopqrstuvwxyz01 这一串" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] };
  if (name === "broken") return { content: [{ type: "text", text: "我这边的查询失败" }], isError: true };
  if (name === "slow") { await sleep(3_000); return { content: [{ type: "text", text: "太晚了" }] }; }
  throw new Error(`未知工具 ${name}`);
});

await server.connect(new StdioServerTransport());
