// Fastify 服务：入口证据写在实例构造与路由登记里，文件名不带框架信息也得认出来。
import Fastify from "fastify";

const app = Fastify({ logger: false });

app.get<{ Params: { id: string } }>("/orders/:id", async (request) => request.params.id);

app.listen({ port: 3000, host: "127.0.0.1" });
