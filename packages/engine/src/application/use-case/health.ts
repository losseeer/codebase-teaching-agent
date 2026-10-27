import { engineVersion } from "../../boot.js";
import { teachingProviderStatus } from "../../llm/provider.js";
import { getLlmRuntimeSettings } from "../../llm/runtime.js";
import { isolationStatus, reprobeIsolation } from "../../sandbox/isolation.js";
import { lightLlm, teachingLlm } from "../../infrastructure/composition-root.js";
import { createSummaryProvider } from "../../summarizer/summary-provider.js";

/**
  引擎自身状态的读数面：健康检查与沙箱重探。
  两处都不许「顺手补一个好看的数」：能力不降级——`level !== "enforced"` 时代码题域照旧禁用，
  健康检查就把逐项 canary 原样吐出去。
  */

/** 生效模型的思考能力与服务商状态：读设置与读健康共用同一套解析。 */
export function healthUseCase() {
  const llm = teachingProviderStatus(teachingLlm());
  return {
    status: "ok", service: "codebase-tutor-engine", version: engineVersion,
    // 摘要档由真源工厂报出：直接读 TUTOR_SUMMARY_PROVIDER 会把「没设环境变量」与「设成空值」两种情况都报歪
    summaryProvider: createSummaryProvider({ llm: lightLlm() }).name,
    llmProvider: llm.provider, llmModel: llm.model, llmMode: llm.mode,
    thinking: getLlmRuntimeSettings().thinking,
    // 沙箱闸门状态原样给出（含逐项 canary 读数）：代码题能不能出看这个节点
    sandbox: isolationStatus()
  };
}

/**
  重跑一次沙箱隔离探测：探测失败会把代码题整域禁用（fail-closed），
  这里提供除重启引擎之外的当场再验一遍。
  */
export async function reprobeSandboxUseCase() {
  const sandbox = await reprobeIsolation();
  console.log(`[engine] 沙箱重探：${sandbox.level === "enforced" ? `强制隔离已验（${sandbox.checks.length} 项 canary 全过 · ${sandbox.backend} · ${sandbox.durationMs}ms）` : `未通过——代码题域继续禁用：${sandbox.reason}`}`);
  return { sandbox };
}
