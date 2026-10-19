// 三条作用域对话共用的闸门：单轮 LLM 讨论，没有本地兜底；预算已达上限或未配置 LLM 时显式 422，不静默回落。
// `gate` 由调用方在开火前算好传进来，避免同一次请求读两趟成本。
import type { FastifyReply } from "fastify";
import type { LlmProvider } from "../llm/provider.js";
import type { RepositoryHandle } from "../store/repository-handle.js";
import { budgetGate } from "../application/paid-turn.js";
import { teachingLlm } from "../services.js";

export function scopedChatProviderOr422(reply: FastifyReply, handle: RepositoryHandle, gate?: { monthlyBudgetUsd: number; degraded: boolean }): LlmProvider | undefined {
  if ((gate ?? budgetGate(handle)).degraded) {
    void reply.code(422).send({ error: "本月预算已达到预算上限，此作用域的 LLM 对话不可用；可在设置中调整预算。" });
    return undefined;
  }
  const teachingProvider = teachingLlm();
  if (!teachingProvider) {
    // 文案里的入口顺序即实际优先级：GUI 的 LLM 设置优先，其次 .env 的 `TUTOR_LLM_*`
    void reply.code(422).send({ error: "尚未配置 LLM（在设置里选服务商与模型，或在 .env 写 TUTOR_LLM_PROVIDER / TUTOR_LLM_MODEL），此作用域的 LLM 对话不可用。" });
    return undefined;
  }
  return teachingProvider;
}
