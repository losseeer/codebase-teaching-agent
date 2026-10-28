import { ExerciseService } from "../exercises/exercises.js";
import { ImportService } from "../importer/importer.js";
import { buildLlmRuntimeProvider, getLlmRuntimeSettings, restoreLlmRuntimeSettings } from "../adapter/outbound/llm/runtime.js";
import type { LlmProvider } from "../application/port/llm-provider.js";
import { tboot } from "../boot.js";

/**
  引擎的运行中单例：`importer`、`exercises`、LLM 角色取用口，路由与用例模块都从这里拿。
  进程入口与监听在 `server.ts`，开机读数与信号收尾在 `infrastructure/bootstrap.ts`。
  */

export const importer = new ImportService();
// 启动只读地址簿里的路径，不读产物；挂载推迟到按仓访问时。
tboot(`ImportService（地址簿 ${importer.catalog().length} 条，挂载 0 条）`);

export const exercises = new ExerciseService();
tboot("ExerciseService");

/** LLM 运行时设置：GUI 可改并落盘，空项回落 `.env`。 */
restoreLlmRuntimeSettings();
const restored = getLlmRuntimeSettings();
if (restored.provider || restored.model || restored.baseUrl || restored.apiKey) console.log(`[startup] 已恢复 GUI 的 LLM 设置（${restored.provider || "服务商回落 .env"} · ${restored.model || "模型回落 .env"}）`);

/** 按角色取 LLM：每次现取，改设置后下一次取用生效。 */
export function teachingLlm(): LlmProvider | undefined {
  return buildLlmRuntimeProvider("teaching");
}

export function lightLlm(): LlmProvider | undefined {
  return buildLlmRuntimeProvider("light");
}

/** 仓库未挂载时给界面的一句话，各路由共用。 */
export const REPOSITORY_NOT_MOUNTED = "这个仓库现在打不开；请重新导入。";

/** 取已挂载的仓库实例，不触发挂载；未挂载时返回 undefined，由调用方回 404。 */
export function repositoryOr404(repositoryId: string) {
  return importer.getRepository(repositoryId);
}
