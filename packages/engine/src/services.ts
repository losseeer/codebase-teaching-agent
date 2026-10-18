import { ExerciseService } from "./exercises/exercises.js";
import { ImportService } from "./importer/importer.js";
import { buildLlmRuntimeProvider, getLlmRuntimeSettings, restoreLlmRuntimeSettings } from "./llm/runtime.js";
import type { LlmProvider } from "./llm/provider.js";
import { tboot } from "./boot.js";

/**
  引擎的运行中单例（组合根）。放在独立一份文件里的理由：路由与用例模块都要拿它们，
  而它们**不能从 `server.ts` 拿**——那会让「HTTP 装配」反过来成为业务模块的依赖源，
  拆出去的每个路由文件都得 import 回 server（循环），最后一个都搬不走。
  `server.ts` 因此退回它本来该做的事：建 fastify、挂钩子、注册路由、listen。
  */

export const importer = new ImportService();
// 启动**只读地址簿**（一串路径），一条产物都不读、一个 fs 监听都不开：
// 挂载推迟到 GUI 真的访问某个仓库时（见 preHandler 懒挂载），超出的按 LRU 驱逐。
tboot(`ImportService（地址簿 ${importer.catalog().length} 条，挂载 0 条）`);

export const exercises = new ExerciseService();
tboot("ExerciseService");

/**
  LLM 运行时设置：服务商/模型/端点/密钥/思考档位来自这里（GUI `PUT /api/llm/settings` 可改，
  落盘持久，重启后仍在；空项回落 .env——.env 是降级策略而非唯一入口）。
  只有一套配置；teaching / light 是**运行时角色**（差别只在思考开关），不是两份配置。
  */
restoreLlmRuntimeSettings();
const restored = getLlmRuntimeSettings();
if (restored.provider || restored.model || restored.baseUrl || restored.apiKey) console.log(`[startup] 已恢复 GUI 的 LLM 设置（${restored.provider || "服务商回落 .env"} · ${restored.model || "模型回落 .env"}）`);

/**
  两个运行时角色的取用口。**每次现取，不留模块级变量**：
  原来这里是 `let teachingProvider / let lightLlmProvider`，改设置的那条路由必须记得重建它们——
  漏一处就是「界面显示新模型而回合还在用旧模型」，而且新增一个消费点时没人会提醒。
  构建不出网（`buildLlmRuntimeProvider` 只是读一份内存设置再包两层），所以不值得配缓存。
  */
export function teachingLlm(): LlmProvider | undefined {
  return buildLlmRuntimeProvider("teaching");
}

export function lightLlm(): LlmProvider | undefined {
  return buildLlmRuntimeProvider("light");
}

/** 所有 `/api/repositories/:repositoryId/*` 的第一道：这条仓现在挂着吗。没挂着就是 404，绝不懒到去读盘。 */
export function repositoryOr404(repositoryId: string) {
  return importer.getRepository(repositoryId);
}
