import { LLM_PROVIDERS, THINKING_EFFORTS } from "../../../outbound/llm/runtime.js";
import { TIMEOUT_MAX_MS, TIMEOUT_MIN_MS } from "../../../outbound/llm/provider.js";
import { REPOSITORY_NOT_MOUNTED } from "../../../../infrastructure/composition-root.js";
import { llmSettingsView, readCostUseCase, saveBudgetUseCase, updateLlmSettingsUseCase, type SettingsFailure } from "../../../../application/use-case/settings.js";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
  配置与成本面的入站翻译：GET/PUT 运行时 LLM 设置、GET 成本读数、PUT 每仓预算。
  取值与保存在 `application/use-case/settings.ts`，这里只做失败种类 → 状态码与文案。
*/
const rejected = (reply: FastifyReply, failure: SettingsFailure): FastifyReply => {
  switch (failure.kind) {
    case "repository-missing": return reply.code(404).send({ error: REPOSITORY_NOT_MOUNTED });
    case "thinking-unsupported": return reply.code(422).send({ error: `thinking 只支持 ${THINKING_EFFORTS.join(" / ")}` });
    case "provider-unsupported": return reply.code(422).send({ error: `服务商只支持 ${LLM_PROVIDERS.join(" / ")}（留空 = 用 .env）` });
    case "url-malformed": return reply.code(422).send({ error: "接口地址不是合法 URL（需带 http:// 或 https:// 前缀）" });
    case "url-protocol": return reply.code(422).send({ error: "接口地址只接受 http:// 或 https://" });
    case "api-key-blank": return reply.code(422).send({ error: "API Key 不能含空格或换行" });
    case "pricing-invalid": return reply.code(422).send({ error: `${failure.label}得是不小于 0 的数字（人民币 / 百万 token），留空表示用 .env 的值`, reason: "pricing_invalid" });
    case "timeout-invalid": return reply.code(422).send({ error: `超时时长得是 ${String(TIMEOUT_MIN_MS)} 到 ${String(TIMEOUT_MAX_MS)} 之间的整数毫秒（留空表示用 .env 的值）`, reason: "timeout_invalid" });
    case "model-thinking-incompatible": return reply.code(422).send({ error: `模型 ${failure.model} 不支持思考档位 "${failure.thinking}"（支持：${failure.supported.length ? failure.supported.join("/") : "无"}）` });
    case "budget-missing": return reply.code(400).send({ error: "请提供 monthlyBudgetUsd" });
    case "budget-invalid": return reply.code(400).send({ error: "预算必须是非负数字" });
  }
};

export function registerSettingsRoutes(app: FastifyInstance): void {
  /** 运行时 LLM 设置的读取：含 `.env` 缺省值、预设模型清单与生效模型的思考能力声明。 */
  app.get("/api/llm/settings", async () => llmSettingsView());

  app.put<{ Body: { provider?: string; model?: string; baseUrl?: string; apiKey?: string; thinking?: string; inputUsdPerMillion?: string; outputUsdPerMillion?: string; cacheHitUsdPerMillion?: string; timeoutMs?: string } }>("/api/llm/settings", async (request, reply) => {
    const result = updateLlmSettingsUseCase(request.body ?? {});
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.get<{ Params: { repositoryId: string }; Querystring: { sessionId?: string } }>("/api/repositories/:repositoryId/cost", async (request, reply) => {
    const result = readCostUseCase(request.params.repositoryId, request.query.sessionId);
    return result.ok ? result.value : rejected(reply, result.failure);
  });

  app.put<{ Params: { repositoryId: string }; Body: { monthlyBudgetUsd?: number } }>("/api/repositories/:repositoryId/settings", async (request, reply) => {
    const result = saveBudgetUseCase(request.params.repositoryId, request.body?.monthlyBudgetUsd);
    return result.ok ? result.value : rejected(reply, result.failure);
  });
}
