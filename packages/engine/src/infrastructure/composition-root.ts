import { ExerciseService } from "../exercises/exercises.js";
import { ImportService } from "../importer/importer.js";
import { buildLlmRuntimeProvider, getLlmRuntimeSettings, restoreLlmRuntimeSettings } from "../adapter/outbound/llm/runtime.js";
import type { LlmProvider } from "../application/port/llm-provider.js";
import { tboot } from "../boot.js";

/**
  引擎的运行中单例（组合根）：路由与用例模块都从这里拿，不从 `server.ts` 拿。
  `server.ts` 只做建 fastify、挂钩子、注册路由、listen。
  同目录另两份是端口装配：认识具体适配器、把端口凑齐这件事集中在这一层。
  */

export const importer = new ImportService();
// 启动只读地址簿那一串路径，不读产物、不开监听；挂载推迟到 GUI 访问某个仓时。
tboot(`ImportService（地址簿 ${importer.catalog().length} 条，挂载 0 条）`);

export const exercises = new ExerciseService();
tboot("ExerciseService");

/** LLM 运行时设置：GUI 可改并落盘，空项回落 `.env`；teaching / light 是角色不是两份配置。 */
restoreLlmRuntimeSettings();
const restored = getLlmRuntimeSettings();
if (restored.provider || restored.model || restored.baseUrl || restored.apiKey) console.log(`[startup] 已恢复 GUI 的 LLM 设置（${restored.provider || "服务商回落 .env"} · ${restored.model || "模型回落 .env"}）`);

/** 两个运行时角色的取用口：每次现取，改设置后下一次取用自动生效。 */
export function teachingLlm(): LlmProvider | undefined {
  return buildLlmRuntimeProvider("teaching");
}

export function lightLlm(): LlmProvider | undefined {
  return buildLlmRuntimeProvider("light");
}

/** 仓路由第一道失败时给界面的一句话：文案单源，各路由共用，不再各抄一份。 */
export const REPOSITORY_NOT_MOUNTED = "这个仓库现在打不开；请重新导入。";

/** 所有 `/api/repositories/:repositoryId/*` 的第一道：这条仓现在挂着吗。没挂着就是 404，绝不懒到去读盘。 */
export function repositoryOr404(repositoryId: string) {
  return importer.getRepository(repositoryId);
}
