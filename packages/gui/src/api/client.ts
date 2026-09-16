import type { ClaudePostToolUseEvent, CompanionAction, CompanionHookResult, CompanionSuggestion, CompanionSummary, CostSummary, CourseNodeDetail, CourseNodePage, CourseTree, Exercise, ExerciseAnswer, ExerciseKind, ExerciseResult, FadedState, ImportJob, ImpactResult, LearnerProfile, PracticeSummary, RepositoryAnalysis, RepositoryIndex, RepositoryOverview, SuggestedEntry, TutorSession, TutorSettings } from "@codebase-tutor/shared";

/**
 * 当前激活的工作区：被学习的仓库 ID 与路径。所有视图（宏观设计 / 代码教学 / 练习评估 / 成本监控）
 * 都以这个 workspace 为锚点。Agent 侧栏、伴侣面板、localStorage 也按 repositoryId 持久化。
 *
 * 对应 prototype `design-prototype.html` 中的 `binds[scope]` 概念。
 */
export interface Workspace {
  repositoryId: string;
  repositoryPath: string;
}

/** LLM 运行时设置（引擎内存态，PUT 后立即生效，重启回落 .env）。 */
export type ThinkingEffort = "auto" | "off" | "low" | "high" | "max";

/** 模型思考能力声明（引擎按模型 slug 查表解析，见 engine llm/thinking.ts）。efforts 为该模型支持的显式档位（auto 恒可用）。 */
export interface ThinkingCapabilityInfo {
  model: string;
  style: "deepseek" | "openai" | "anthropic" | "none" | "unknown";
  efforts: Exclude<ThinkingEffort, "auto">[];
}

export interface LlmSettings {
  teachingModel: string;
  lightModel: string;
  thinking: ThinkingEffort;
  presets: string[];
  teachingThinking?: ThinkingCapabilityInfo;
  lightThinking?: ThinkingCapabilityInfo;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, ...init });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "请求失败");
  return body;
}

export const api = {
  health: () => request<{ status: string }>("/api/health"),
  getLlmSettings: () => request<LlmSettings>("/api/llm/settings"),
  updateLlmSettings: (partial: { teachingModel?: string; lightModel?: string; thinking?: ThinkingEffort }) => request<LlmSettings>("/api/llm/settings", { method: "PUT", body: JSON.stringify(partial) }),
  submitImport: (path: string) => request<ImportJob>("/api/imports", { method: "POST", body: JSON.stringify({ path }) }),
  getImport: (jobId: string) => request<ImportJob>(`/api/imports/${jobId}`),
  getIndex: (repositoryId: string) => request<RepositoryIndex>(`/api/repositories/${repositoryId}/index`),
  getCourse: (repositoryId: string) => request<CourseTree>(`/api/repositories/${repositoryId}/course`),
  getOverview: (repositoryId: string) => request<RepositoryOverview>(`/api/repositories/${repositoryId}/overview`),
  getCourseNodes: (repositoryId: string, parentId: string, offset = 0, limit = 30) => request<CourseNodePage>(`/api/repositories/${repositoryId}/course/nodes?parentId=${encodeURIComponent(parentId)}&offset=${offset}&limit=${limit}`),
  getCourseNodeDetail: (repositoryId: string, nodeId: string) => request<CourseNodeDetail>(`/api/repositories/${repositoryId}/analysis/node?nodeId=${encodeURIComponent(nodeId)}`),
  getAnalysis: (repositoryId: string) => request<RepositoryAnalysis>(`/api/repositories/${repositoryId}/analysis`),
  getReport: (repositoryId: string) => request<{ index: RepositoryIndex; estimate: { cachedFiles: number; summarizedFiles: number; estimatedInputTokens: number; estimatedCostUsd: number; provider: string }; entrypoints: { title: string; anchors: { path: string; line: number }[] }[] }>(`/api/repositories/${repositoryId}/report`),
  getSource: (repositoryId: string, path: string, line: number) => request<{ path: string; line: number; content: string }>(`/api/repositories/${repositoryId}/source?path=${encodeURIComponent(path)}&line=${line}`),
  getImpact: (repositoryId: string, changedPaths: string[]) => request<ImpactResult>(`/api/repositories/${repositoryId}/impact`, { method: "POST", body: JSON.stringify({ changedPaths }) }),
  getCompanionSuggestions: (repositoryId: string) => request<{ suggestions: CompanionSuggestion[]; summary: CompanionSummary }>(`/api/repositories/${repositoryId}/companion/suggestions`),
  getModuleEntries: (repositoryId: string, moduleLabel: string, moduleHint?: string) => request<{ entries: SuggestedEntry[]; source: "llm" | "heuristic" }>(`/api/repositories/${repositoryId}/module-entries?module=${encodeURIComponent(moduleLabel)}&hint=${encodeURIComponent(moduleHint ?? "")}`),
  postToolUse: (repositoryId: string, event: ClaudePostToolUseEvent) => request<CompanionHookResult>(`/api/repositories/${repositoryId}/companion/hooks/post-tool-use`, { method: "POST", body: JSON.stringify(event) }),
  actOnSuggestion: (repositoryId: string, suggestionId: string, action: CompanionAction) => request<CompanionSuggestion>(`/api/repositories/${repositoryId}/companion/suggestions/${encodeURIComponent(suggestionId)}/actions`, { method: "POST", body: JSON.stringify({ action }) }),
  getPractice: (repositoryId: string) => request<PracticeSummary>(`/api/repositories/${repositoryId}/practice`),
  getLearner: (repositoryId: string) => request<LearnerProfile>(`/api/repositories/${repositoryId}/learner`),
  createExercise: (repositoryId: string, options: { kind?: ExerciseKind; targetUnitId?: string; moduleId?: string; moduleIds?: string[]; family?: "comprehension" | "llm"; tag?: string; tagId?: string; variantNonce?: number } = {}) => request<Exercise>(`/api/repositories/${repositoryId}/exercises`, { method: "POST", body: JSON.stringify(options) }),
  submitExercise: (repositoryId: string, exerciseId: string, answer: ExerciseAnswer) => request<ExerciseResult>(`/api/repositories/${repositoryId}/exercises/${encodeURIComponent(exerciseId)}/answer`, { method: "POST", body: JSON.stringify(answer) }),
  getCost: (repositoryId: string, sessionId?: string) => request<CostSummary>(`/api/repositories/${repositoryId}/cost${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  setBudget: (repositoryId: string, monthlyBudgetUsd: number) => request<CostSummary>(`/api/repositories/${repositoryId}/settings`, { method: "PUT", body: JSON.stringify({ monthlyBudgetUsd }) }),
  createSession: (repositoryId: string, courseNodeId: string, settings?: TutorSettings) => request<{ session: TutorSession; recommendedSettings: LearnerProfile["recommended"]; faded: FadedState }>("/api/sessions", { method: "POST", body: JSON.stringify({ repositoryId, courseNodeId, ...(settings ? { settings } : {}) }) }),
  sendMessage: (sessionId: string, content: string, settings: TutorSettings) => request<{ session: TutorSession; message: { content: string }; cost: CostSummary; provider: string }>(`/api/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content, settings }) }),
  /** map-chat 流式版：SSE 逐事件回调过程指示（thinking / reading），resolve 于 done 事件。 */
  mapChatStream: async (repositoryId: string, payload: { content: string; nodeId?: string; path?: string; style: number }, onProgress: (progress: { stage: "thinking"; round: number } | { stage: "reading"; path: string }) => void): Promise<{ reply: string; provider: string }> => {
    const response = await fetch(`/api/repositories/${repositoryId}/map-chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({ error: "请求失败" })) as { error?: string };
      throw new Error(body.error ?? "请求失败");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: { reply: string; provider: string } | undefined;
    const consume = (chunk: string): void => {
      const line = chunk.startsWith("data: ") ? chunk.slice(6) : "";
      if (!line) return;
      const event = JSON.parse(line) as { type: string; round?: number; path?: string; reply?: string; provider?: string; error?: string };
      if (event.type === "thinking") {
        onProgress({ stage: "thinking", round: event.round ?? 1 });
      } else if (event.type === "reading") {
        onProgress({ stage: "reading", path: event.path ?? "" });
      } else if (event.type === "done") {
        final = { reply: event.reply ?? "", provider: event.provider ?? "" };
      } else if (event.type === "error") {
        throw new Error(event.error ?? "LLM 对话失败");
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (!final) throw new Error("连接中断，未收到完整回复");
    return final;
  },
  practiceChat: (repositoryId: string, payload: { content: string; exerciseId: string; style: number }) => request<{ reply: string; provider: string }>(`/api/repositories/${repositoryId}/practice-chat`, { method: "POST", body: JSON.stringify(payload) })
};
