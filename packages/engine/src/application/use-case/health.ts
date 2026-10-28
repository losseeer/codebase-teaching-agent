import { engineVersion } from "../../boot.js";
import { teachingProviderStatus } from "../../adapter/outbound/llm/provider.js";
import { getLlmRuntimeSettings } from "../../adapter/outbound/llm/runtime.js";
import { isolationStatus, reprobeIsolation } from "../../adapter/outbound/sandbox/isolation.js";
import { lightLlm, teachingLlm } from "../../infrastructure/composition-root.js";
import { createSummaryProvider } from "../../summarizer/summary-provider.js";

/** 引擎自身状态的读数面：健康检查与沙箱重探。 */

/** 引擎健康读数：版本、生效模型的服务商状态、沙箱隔离状态。 */
export function healthUseCase() {
  const llm = teachingProviderStatus(teachingLlm());
  return {
    status: "ok", service: "codebase-tutor-engine", version: engineVersion,
    summaryProvider: createSummaryProvider({ llm: lightLlm() }).name,
    llmProvider: llm.provider, llmModel: llm.model, llmMode: llm.mode,
    thinking: getLlmRuntimeSettings().thinking,
    sandbox: isolationStatus()
  };
}

/** 重跑一次沙箱隔离探测。 */
export async function reprobeSandboxUseCase() {
  const sandbox = await reprobeIsolation();
  console.log(`[engine] 沙箱重探：${sandbox.level === "enforced" ? `强制隔离已验（${sandbox.checks.length} 项 canary 全过 · ${sandbox.backend} · ${sandbox.durationMs}ms）` : `未通过——代码题域继续禁用：${sandbox.reason}`}`);
  return { sandbox };
}
