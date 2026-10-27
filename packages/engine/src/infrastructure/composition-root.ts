import { ExerciseService } from "../exercises/exercises.js";
import { ImportService } from "../importer/importer.js";
import { buildLlmRuntimeProvider, getLlmRuntimeSettings, restoreLlmRuntimeSettings } from "../adapter/outbound/llm/runtime.js";
import type { LlmProvider } from "../application/port/llm-provider.js";
import { tboot } from "../boot.js";

/**
  引擎的运行中单例（组合根）：路由与用例模块都从这里拿，不能从 `server.ts` 拿——
  否则「HTTP 装配」反过来成为业务模块的依赖源，拆出去的路由全要 import 回 server。
  `server.ts` 因此只做建 fastify、挂钩子、注册路由、listen。
  同目录另两份是端口装配（`exercise-ports.ts` / `canvas-tools.ts`）：「认识具体适配器、把端口凑齐」这件事集中在这一层，
  用例侧只认 `application/port/` 那些接口——现在还有 26 条边直接伸进适配器，那条在册预算记着这笔债与方向。
  */

export const importer = new ImportService();
// 启动只读地址簿（一串路径），一条产物都不读、一个 fs 监听都不开：
// 挂载推迟到 GUI 真的访问某个仓库时（见 preHandler 懒挂载），超出的按 LRU 驱逐。
tboot(`ImportService（地址簿 ${importer.catalog().length} 条，挂载 0 条）`);

export const exercises = new ExerciseService();
tboot("ExerciseService");

/**
  LLM 运行时设置：服务商/模型/端点/密钥/思考档位来自这里（GUI `PUT /api/llm/settings` 可改，
  落盘持久，重启后仍在；空项回落 .env——.env 是降级策略而非唯一入口）。
  只有一套配置；teaching / light 是运行时角色（差别只在思考开关），不是两份配置。
  */
restoreLlmRuntimeSettings();
const restored = getLlmRuntimeSettings();
if (restored.provider || restored.model || restored.baseUrl || restored.apiKey) console.log(`[startup] 已恢复 GUI 的 LLM 设置（${restored.provider || "服务商回落 .env"} · ${restored.model || "模型回落 .env"}）`);

/**
  两个运行时角色的取用口：每次现取，不留模块级变量——改设置后下一次取用自动生效，
  消费侧没有「记得重建」的义务；构建只是读一份内存设置再包两层，不值得配缓存。
  */
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
