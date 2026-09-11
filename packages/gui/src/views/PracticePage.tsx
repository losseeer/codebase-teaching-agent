import { useEffect, useState, type ReactElement } from "react";
import { BrainCircuit, CheckCircle2, Code2, RefreshCw } from "lucide-react";
import type { Exercise, ExerciseKind, ExerciseResult, PracticeSummary } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import { exerciseKindLabel } from "./helpers";

/**
 * 练习复习工作区：生成练习（4 种题型）→ 答题 → 自动判分 → SM-2 复习调度。
 * - 题型：output_prediction / change_localization / impact_analysis / decision_defense
 * - 输入模式：text / multi_select / evidence_and_text
 * - 判分模式：execution / set_match / rubric
 *
 * 对应 prototype `design-prototype.html` 中的「练习复习」视图（4 类练习 + 模块 chips）。
 * 当前 GUI 用工具栏下拉选题型；v0.2+ 引入 prototype 的模块 chips 与四类卡片网格。
 */

export function PracticePage({ workspace }: { workspace: Workspace }): ReactElement {
  const [summary, setSummary] = useState<PracticeSummary | null>(null);
  const [exercise, setExercise] = useState<Exercise | null>(null);
  const [kind, setKind] = useState<ExerciseKind | "">("");
  const [text, setText] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [result, setResult] = useState<ExerciseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refreshSummary = (): void => { api.getPractice(workspace.repositoryId).then(setSummary).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取练习进度")); };
  useEffect(refreshSummary, [workspace.repositoryId]);
  const loadExercise = async (): Promise<void> => {
    setLoading(true); setError(""); setResult(null); setText(""); setSelectedIds([]);
    try { setExercise(await api.createExercise(workspace.repositoryId, kind ? { kind } : {})); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法生成练习"); }
    finally { setLoading(false); }
  };
  const toggle = (id: string): void => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const submit = async (): Promise<void> => {
    if (!exercise) return;
    setLoading(true); setError("");
    try {
      const answer = exercise.inputMode === "text" ? { text } : exercise.inputMode === "multi_select" ? { selectedIds } : { selectedIds, rationale: text };
      setResult(await api.submitExercise(workspace.repositoryId, exercise.id, answer));
      refreshSummary();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法提交答案"); }
    finally { setLoading(false); }
  };
  const recentMastery = [...(summary?.mastery ?? [])].sort((left, right) => (right.lastPracticedAt ?? "").localeCompare(left.lastPracticedAt ?? ""))[0]?.level ?? 1;
  return (
    <section className="page practice-page">
      <header className="page-heading practice-header">
        <div>
          <p className="eyebrow">间隔复习</p>
          <h1>源码练习</h1>
          <p>题目只基于当前内容版本的实现、依赖图和已标注证据生成。</p>
        </div>
        <div className="practice-meta"><span>待复习 {summary?.dueReviews ?? 0}</span><span>最近掌握度 {recentMastery}</span></div>
      </header>
      <div className="practice-toolbar">
        <label>题型
          <select value={kind} onChange={(event) => setKind(event.target.value as ExerciseKind | "")} aria-label="练习题型">
            <option value="">自适应推荐</option>
            <option value="output_prediction">预测输出</option>
            <option value="change_localization">修改定位</option>
            <option value="impact_analysis">影响分析</option>
            <option value="decision_defense">选型辩护</option>
          </select>
        </label>
        <button className="primary" onClick={() => void loadExercise()} disabled={loading}>
          {loading ? <RefreshCw className="spin" size={17} /> : <BrainCircuit size={17} />}生成练习
        </button>
      </div>
      {error && <p className="error-message">{error}</p>}
      {!exercise ? (
        <div className="practice-empty"><BrainCircuit size={28} /><p>生成一道练习，开始一次针对当前仓库的复习。</p></div>
      ) : (
        <div className="practice-workspace">
          <article className="exercise-surface">
            <div className="exercise-heading">
              <div>
                <span className="kind-badge">{exerciseKindLabel(exercise.kind)}</span>
                <h2>{exercise.title}</h2>
              </div>
              <span className="difficulty">难度 {exercise.difficulty}/5</span>
            </div>
            <p className="exercise-prompt">{exercise.prompt}</p>
            {exercise.anchors.length ? (
              <div className="exercise-anchors">
                {exercise.anchors.map((anchor) => <span key={`${anchor.path}:${anchor.line}`}><Code2 size={13} />{anchor.path}:{anchor.line}</span>)}
              </div>
            ) : null}
            {exercise.inputMode === "text" ? (
              <textarea className="exercise-text" value={text} onChange={(event) => setText(event.target.value)} rows={4} placeholder="填写你预测的返回值" aria-label="练习答案" />
            ) : (
              <div className="exercise-options">
                {exercise.options?.map((option) => (
                  <label key={option.id} className={selectedIds.includes(option.id) ? "exercise-option checked" : "exercise-option"}>
                    <input type="checkbox" checked={selectedIds.includes(option.id)} onChange={() => toggle(option.id)} />
                    <span><code>{option.label}</code>{option.detail ? <small>{option.detail}</small> : null}</span>
                  </label>
                ))}
              </div>
            )}
            {exercise.inputMode === "evidence_and_text" ? (
              <textarea className="exercise-text" value={text} onChange={(event) => setText(event.target.value)} rows={4} placeholder="说明证据如何支撑结论，并标注证据强度" aria-label="辩护理由" />
            ) : null}
            <div className="exercise-actions">
              <button className="primary" onClick={() => void submit()} disabled={loading || (exercise.inputMode === "text" && !text.trim()) || (exercise.inputMode === "evidence_and_text" && !text.trim())}>
                {loading ? <RefreshCw className="spin" size={17} /> : <CheckCircle2 size={17} />}提交并判分
              </button>
              <button className="secondary" onClick={() => void loadExercise()} disabled={loading}>换一题</button>
            </div>
          </article>
          <aside className="practice-status">
            <h2>复习状态</h2>
            <div><span>内容版本</span><code>{exercise.contentVersion.slice(0, 19)}</code></div>
            <div><span>判分方式</span><strong>{exercise.gradingMode === "execution" ? "受限执行验证" : exercise.gradingMode === "set_match" ? "集合精确匹配" : "证据 Rubric"}</strong></div>
            {result ? (
              <div className={`result-panel ${result.passed ? "passed" : "needs-work"}`}>
                <strong>{result.passed ? "已通过" : "继续完善"}</strong>
                <output>{Math.round(result.score * 100)}%</output>
                <p>{result.feedback}</p>
                <small>下次复习：{new Date(result.review.dueAt).toLocaleDateString()}</small>
                {result.rubric?.map((criterion) => <p className="rubric-line" key={criterion.id}>{criterion.label} {Math.round(criterion.score * 100)}/{Math.round(criterion.maxScore * 100)} · {criterion.feedback}</p>)}
              </div>
            ) : <p>完成后会更新 SM-2 间隔和单元掌握度。</p>}
          </aside>
        </div>
      )}
    </section>
  );
}