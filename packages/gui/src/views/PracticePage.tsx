import { useEffect, useState, type ReactElement } from "react";
import { BrainCircuit, CheckCircle2, RefreshCw } from "lucide-react";
import type { Exercise, ExerciseGradingMode, ExerciseResult, MasteryRecord, PracticeSummary } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import type { TeachingSessionApi } from "../agent/useTeachingSession";
import { exerciseKindLabel } from "./helpers";
import { ContextLine, MobileSwitcher, useMobilePanes } from "./WorkspaceChrome";
import { ModulesPane, ModuleSectionLabel } from "../modules/ModulesPane";
import { showToast } from "../modules/toast";
import { loadActiveModule, loadPracticeModules, saveActiveModule, savePracticeModules, COMPREHENSION_MODULE_ID, type KnowledgeModule } from "../modules/store";
import { SourceView, type SourcePayload } from "../source/SourceView";

/**
  练习复习工作区（对齐 prototype `.practice-workspace`，两栏）：
  - 左 「练习模块」（modules-pane）：模块 chips + 配置 + 「模块内的练习」卡片列表（真实掌握度记录，点击按 targetUnitId 重新出题）
  - 右 「练习上下文」（source-pane）：相关代码（高亮）→ 你的回答（文本 / 选项）→ 提交回答 / 换一题 → 反馈面板
  - 生成练习入口放在上下文行的 `.context-actions`（题型选择 + 生成），判分结果同时推送到 practice 线程

  对应 prototype `design-prototype.html` L67 / L330-342（practice-workspace + 练习上下文 + answer + feedback）。
  */

function gradingLabel(mode: ExerciseGradingMode): string {
  if (mode === "execution") return "受限执行验证";
  if (mode === "rubric") return "rubric 细则判分（LLM 比对参考答案）";
  return "集合精确匹配";
}

function unitName(unitId: string): string {
  // LLM 出题单元 id 形如 llm:<tagId>:<nonce>，展示为主题练习序号
  if (unitId.startsWith("llm:")) {
    const nonce = Number(unitId.split(":")[2] ?? 0);
    return `主题练习 #${Number.isFinite(nonce) ? nonce + 1 : unitId}`;
  }
  const tail = unitId.split(":").pop() ?? unitId;
  return tail.replace(/^[a-z]+-/, "") || tail;
}

/** LLM 出题单元的 variantNonce（换一题 = 旧 nonce + 1）。 */
function llmNonce(unitId: string): number {
  const nonce = Number(unitId.split(":")[2] ?? 0);
  return Number.isFinite(nonce) ? nonce : 0;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));
}

export function PracticePage({ workspace, session: t }: { workspace: Workspace; session: TeachingSessionApi }): ReactElement {
  const repositoryId = workspace.repositoryId;
  const [summary, setSummary] = useState<PracticeSummary | null>(null);
  const [exercise, setExercise] = useState<Exercise | null>(null);
  const [text, setText] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [result, setResult] = useState<ExerciseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [source, setSource] = useState<SourcePayload | null>(null);
  const [modules, setModules] = useState<KnowledgeModule[]>(loadPracticeModules);
  const [activeModule, setActiveModule] = useState<string>(() => loadActiveModule("practice", modules));
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();

  useEffect(() => { savePracticeModules(modules); }, [modules]);
  useEffect(() => { saveActiveModule("practice", activeModule); }, [activeModule]);

  const refreshSummary = (): void => {
    api.getPractice(repositoryId).then(setSummary).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取练习进度"));
  };
  useEffect(refreshSummary, [repositoryId]);

  // 出题分派：活动 chip = 程序理解题 → 规则出题族；自定义主题 chip → LLM 出题族（family 对用户不可见）。
  // 「换一题」对 LLM 题走 variantNonce+1（出新题，旧题保留）；对规则题按 targetUnitId 重出。
  const generate = async (targetUnitId?: string, variantNonce?: number): Promise<void> => {
    setLoading(true); setError(""); setResult(null); setText(""); setSelectedIds([]);
    const isLlmFamily = activeModule !== COMPREHENSION_MODULE_ID;
    try {
      const next = await api.createExercise(repositoryId, isLlmFamily
        ? {
            family: "llm",
            tag: modules.find((item) => item.id === activeModule)?.label ?? activeModule,
            tagId: activeModule,
            ...(variantNonce !== undefined ? { variantNonce } : {})
          }
        : {
            family: "comprehension",
            ...(targetUnitId ? { targetUnitId } : {})
          });
      setExercise(next);
      t.setPracticeUnit(next.title);
      t.setPracticeExercise(next);
      showToast(`新练习 · ${exerciseKindLabel(next.kind)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法生成练习");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const anchor = exercise?.anchors[0];
    if (!anchor) { setSource(null); return; }
    let current = true;
    api.getSource(repositoryId, anchor.path, anchor.line).then((next) => { if (current) setSource(next); }).catch(() => { if (current) setSource(null); });
    return () => { current = false; };
  }, [exercise?.id, repositoryId]);

  const toggle = (id: string): void => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const submit = async (): Promise<void> => {
    if (!exercise) return;
    setLoading(true); setError("");
    try {
      const answer = exercise.inputMode === "multi_select" ? { selectedIds } : { text };
      const next = await api.submitExercise(repositoryId, exercise.id, answer);
      setResult(next);
      refreshSummary();
      t.pushMessage("practice", "agent", `判分完成：${next.passed ? "已通过" : "继续完善"}（${Math.round(next.score * 100)}%）· ${escapeHtml(next.feedback)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法提交答案");
    } finally {
      setLoading(false);
    }
  };

  const isComprehensionChip = activeModule === COMPREHENSION_MODULE_ID;
  const moduleMastery = (summary?.mastery ?? [])
    .filter((record) => isComprehensionChip ? !record.unitId.startsWith("llm:") : record.unitId.startsWith(`llm:${activeModule}:`))
    .sort((left, right) => (right.lastPracticedAt ?? "").localeCompare(left.lastPracticedAt ?? ""));
  const moduleLabel = modules.find((item) => item.id === activeModule)?.label ?? "未命名模块";
  const anchor = exercise?.anchors[0];
  const canSubmit = !loading && (exercise?.inputMode === "multi_select" ? selectedIds.length > 0 : text.trim().length > 0);

  return (
    <section className="page practice-page">
      <header className="practice-header-compact">
        <p className="eyebrow">间隔复习</p>
        <h1>源码练习</h1>
        <div className="practice-meta"><span>待复习 {summary?.dueReviews ?? 0}</span><span>已练单元 {summary?.mastery.length ?? 0}</span></div>
      </header>
      <ContextLine strong="练习复习" detail={`模块「${moduleLabel}」 · 反馈会回写学习状态`} />
      <MobileSwitcher labels={["练习模块", "练习上下文"]} active={paneActive} onSelect={setPaneActive} />
      <div className="workspace practice-workspace">
        <div className={paneClass(0)}>
          <ModulesPane
            where="practice"
            header="练习模块"
            modules={modules}
            activeId={activeModule}
            onSelectModule={setActiveModule}
            onModulesChange={(next, nextActive) => { setModules(next); setActiveModule(nextActive); }}
          >
            <p className="module-hint">{modules.find((item) => item.id === activeModule)?.hint ?? ""} · 主题可在「＋ 配置」里自定义</p>
            <ModuleSectionLabel label="模块内的练习" note={`${moduleMastery.length} 项`} />
            {moduleMastery.length ? (
              <div className="exercise-list">
                {moduleMastery.map((record) => (
                  <ExerciseCard
                    key={record.unitId}
                    record={record}
                    selected={exercise?.targetUnitId === record.unitId}
                    onPick={() => void(record.unitId.startsWith("llm:") ? generate(undefined, llmNonce(record.unitId)) : generate(record.unitId))}
                  />
                ))}
              </div>
            ) : (
              <p className="entry-empty">{isComprehensionChip ? "该模块下暂时没有练习记录。用上方「生成练习」开始一次针对当前仓库的复习。" : "该主题下暂时没有练习记录。点「生成练习」，LLM 会围绕这个主题出题。"}</p>
            )}
          </ModulesPane>
        </div>

        <section className={`pane practice-context ${paneClass(1)}`}>
          <div className="pane-header"><h2>练习上下文</h2><span>{anchor ? `${anchor.path} · 第 ${anchor.line} 行` : "尚未生成练习"}</span></div>
          <div className="source-meta">
            <span>{anchor ? "相关代码已高亮" : "生成练习后显示相关代码"}</span>
            <span>{exercise ? `${gradingLabel(exercise.gradingMode)} · 内容版本 ${exercise.contentVersion.slice(0, 14)}` : "—"}</span>
          </div>
          {error ? <p className="error-message practice-error">{error}</p> : null}
          {exercise ? (
            <>
              <div className="practice-code"><SourceView source={source} /></div>
              <div className="answer">
                <div className="answer-prompt">
                  <div>
                    <span className="kind-badge">{exerciseKindLabel(exercise.kind)}</span>
                    <h2>{exercise.title}</h2>
                  </div>
                  <span className="difficulty">难度 {exercise.difficulty}/5</span>
                </div>
                <p className="exercise-prompt">{exercise.prompt}</p>
                <span className="answer-label">你的回答</span>
                {exercise.inputMode === "multi_select" ? (
                  <div className="option-list">
                    {exercise.options?.map((option) => (
                      <label key={option.id} className={selectedIds.includes(option.id) ? "option checked" : "option"}>
                        <input type="checkbox" checked={selectedIds.includes(option.id)} onChange={() => toggle(option.id)} />
                        <span><code>{option.label}</code>{option.detail ? <small>{option.detail}</small> : null}</span>
                      </label>
                    ))}
                  </div>
                ) : null}
                {exercise.inputMode !== "multi_select" ? (
                  <textarea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    rows={4}
                    aria-label="练习答案"
                    placeholder={exercise.gradingMode === "rubric" ? "用自己的话写出你的分析" : "只填写你预测的返回值"}
                  />
                ) : null}
                <div className="answer-actions">
                  <button className="primary" onClick={() => void submit()} disabled={!canSubmit}>
                    {loading ? <RefreshCw className="spin" size={15} /> : <CheckCircle2 size={15} />}提交回答
                  </button>
                  <button className="secondary" onClick={() => void(exercise.kind === "llm_rubric" ? generate(undefined, llmNonce(exercise.targetUnitId) + 1) : generate(exercise.targetUnitId))} disabled={loading}>换一题</button>
                </div>
                <div className={`feedback${result ? (result.passed ? " passed" : " needs-work") : ""}`}>
                  <strong>{result ? "反馈状态 · 已记录" : "反馈状态 · 尚未提交"}</strong>
                  {result ? (
                    <>
                      <p>{result.passed ? "已通过" : "继续完善"} · 得分 {Math.round(result.score * 100)}% · {result.feedback}</p>
                      <p>下次复习：{new Date(result.review.dueAt).toLocaleDateString()}（间隔 {result.review.intervalDays} 天）</p>
                    </>
                  ) : (
                    <p>完成回答后，这里会显示判分反馈、掌握度变化和下次复习时间。</p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="practice-empty">
              <BrainCircuit size={26} />
              <p>从左栏选一个已练单元，或用上方「生成练习」针对当前仓库出一道新题。</p>
              <button className="primary" onClick={() => void generate()} disabled={loading}>{loading ? <RefreshCw className="spin" size={15} /> : <BrainCircuit size={15} />}生成练习</button>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function ExerciseCard({ record, selected, onPick }: { record: MasteryRecord; selected: boolean; onPick: () => void }): ReactElement {
  return (
    <button className={`exercise-card${selected ? " selected" : ""}`} title={record.unitId} onClick={onPick}>
      <small>掌握度 {record.level}/5 · 练习 {record.attempts} 次</small>
      <strong>{unitName(record.unitId)}</strong>
      <span>{record.lastPracticedAt ? `上次练习 ${new Date(record.lastPracticedAt).toLocaleDateString()} · 点击重新出题` : "尚无练习记录 · 点击出题"}</span>
    </button>
  );
}
