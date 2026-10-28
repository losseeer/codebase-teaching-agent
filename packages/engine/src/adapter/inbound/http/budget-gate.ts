// 三条作用域对话共用的预算闸门：预算达上限或未配置 LLM 时回 422，不静默降级。
// `gate` 由调用方在开火前算好传入。
import type { FastifyReply } from "fastify";
import type { LlmProvider } from "../../../application/port/llm-provider.js";
import type { RepositoryHandle } from "../../outbound/persistence/repository-handle.js";
import { budgetGate } from "../../../application/orchestration/paid-turn.js";
import { teachingLlm } from "../../../infrastructure/composition-root.js";

export function scopedChatProviderOr422(reply: FastifyReply, handle: RepositoryHandle, gate?: { monthlyBudgetUsd: number; degraded: boolean }): LlmProvider | undefined {
  if ((gate ?? budgetGate(handle)).degraded) {
    void reply.code(422).send({ error: "本月预算已用完，这个对话暂时用不了；可在「模型与计价」里调整额度。" });
    return undefined;
  }
  const teachingProvider = teachingLlm();
  if (!teachingProvider) {
    void reply.code(422).send({ error: "还没配置模型，这个对话暂时用不了；在「模型与计价」里选服务商与模型即可。" });
    return undefined;
  }
  return teachingProvider;
}
