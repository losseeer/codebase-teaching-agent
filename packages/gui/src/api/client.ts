import type { ClaudePostToolUseEvent, CompanionAction, CompanionHookResult, CompanionSuggestion, CompanionSummary, CostSummary, CourseNodeDetail, CourseNodePage, CourseTree, Exercise, ExerciseAnswer, ExerciseKind, ExerciseResult, FadedState, ImportJob, ImpactResult, LearnerProfile, PracticeSummary, RepositoryAnalysis, RepositoryIndex, RepositoryOverview, SuggestedEntry, TutorSession, TutorSettings } from "@codebase-tutor/shared";

/**
 * 当前激活的工作区：被学习的仓库 ID 与路径。所有视图（课程地图 / 教学会话 / 练习复习 / 成本监控）
 * 都以这个 workspace 为锚点。Agent 侧栏、伴侣面板、localStorage 也按 repositoryId 持久化。
 *
 * 对应 prototype `design-prototype.html` 中的 `binds[scope]` 概念。
 */
export interface Workspace {
  repositoryId: string;
  repositoryPath: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, ...init });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "请求失败");
  return body;
}

export const api = {
  health: () => request<{ status: string }>("/api/health"),
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
  createExercise: (repositoryId: string, options: { kind?: ExerciseKind; targetUnitId?: string; moduleId?: string; moduleIds?: string[] } = {}) => request<Exercise>(`/api/repositories/${repositoryId}/exercises`, { method: "POST", body: JSON.stringify(options) }),
  submitExercise: (repositoryId: string, exerciseId: string, answer: ExerciseAnswer) => request<ExerciseResult>(`/api/repositories/${repositoryId}/exercises/${encodeURIComponent(exerciseId)}/answer`, { method: "POST", body: JSON.stringify(answer) }),
  getCost: (repositoryId: string, sessionId?: string) => request<CostSummary>(`/api/repositories/${repositoryId}/cost${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`),
  setBudget: (repositoryId: string, monthlyBudgetUsd: number) => request<CostSummary>(`/api/repositories/${repositoryId}/settings`, { method: "PUT", body: JSON.stringify({ monthlyBudgetUsd }) }),
  createSession: (repositoryId: string, courseNodeId: string, settings?: TutorSettings) => request<{ session: TutorSession; recommendedSettings: LearnerProfile["recommended"]; faded: FadedState }>("/api/sessions", { method: "POST", body: JSON.stringify({ repositoryId, courseNodeId, ...(settings ? { settings } : {}) }) }),
  sendMessage: (sessionId: string, content: string, settings: TutorSettings) => request<{ session: TutorSession; message: { content: string }; cost: CostSummary }>(`/api/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content, settings }) })
};
