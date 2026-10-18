// 三条作用域对话（宏观设计 / 代码问答 / 练习评估）共用的闸门：单轮 LLM 讨论，无阶梯无本地兜底；
// 预算已达上限或未配置 LLM 时显式 422（不静默回落）。`gate` 由调用方在开火前算好传进来，避免同一次请求读两趟成本。
// 住在这里（而不是某条路由文件里）的理由：四个消费方跨三个路由分组共用同一句 422 文案——抄两遍迟早分叉。
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
    // 指路要指当前的入口：GUI 的 LLM 设置优先，.env 那一层只有 `TUTOR_LLM_*` 一套（旧别名已于 10-18 停止读取）
    void reply.code(422).send({ error: "尚未配置 LLM（在设置里选服务商与模型，或在 .env 写 TUTOR_LLM_PROVIDER / TUTOR_LLM_MODEL），此作用域的 LLM 对话不可用。" });
    return undefined;
  }
  return teachingProvider;
}
