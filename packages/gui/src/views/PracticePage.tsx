import { ExerciseGradingMode, ExerciseKind, ExerciseResult, MasteryRecord, PracticeSummary } from "@codebase-tutor/domain";
import type { Exercise } from "@codebase-tutor/domain";

import {useEffect, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { CodeEditor, type CodeEditorFile } from "../source/CodeEditor";
import { api, type Workspace } from "../api/client";
import type { ScopedChatApi } from "../agent/scopedChatApi";
import { Markdown } from "../agent/Markdown";
import { dateText, exerciseKindLabel } from "../ui/labels";
import { MobileSwitcher, PageTopbar, useMobilePanes } from "./WorkspaceChrome";
import { ColumnResizer } from "../ui/ColumnResizer";
import { PracticeThemes, PracticeSectionLabel } from "./PracticeThemes";
import { Icon } from "../ui/icons";
import { emit } from "../journal";
import { showToast } from "../ui/toast";
import { useEverVisible } from "../ui/useEverVisible";
import { loadActiveTheme, loadPracticeThemes, saveActiveTheme, savePracticeThemes, COMPREHENSION_THEME_ID, PRACTICE_DEFAULT_THEMES, type PracticeTheme } from "./practiceThemeState";
import { SourceView, isLineRendered, MAX_RENDER_LINES, type SourcePayload } from "../source/SourceView";

// 练习评估工作区两栏：左 = 主题 chips 与本主题已练卡片，右 = 出题与判分。
// 顶栏只报 getPractice 的真读数；出题中不画假进度。
// 判分说法只由 result.gradingMode 决定，复习读数只取 result.review 里存在的字段。

function gradingLabel(mode: ExerciseGradingMode): string {
  if (mode === "execution") return "跑测试判分";
  if (mode === "rubric") return "LLM 按评分细则比对参考答案";
  return "与标准答案逐项比对";
}

/** LLM 出题单元 id 的版本号段（`llm:<tagId>:<nonce>`）；解析不出返回 null，两处判据共用。 */
function llmUnitNonce(unitId: string): number | null {
  const nonce = Number(unitId.split(":")[2] ?? 0);
  return Number.isFinite(nonce) ? nonce : null;
}

/** 规则题单元 id 的首段 → 中文短名。 */
const FAMILY_WORD: Record<string, string> = { impact: "影响面", implementation: "实现" };

function unitName(unitId: string): string {
  if (unitId.startsWith("llm:")) {
    const nonce = llmUnitNonce(unitId);
    return `主题练习 #${nonce !== null ? nonce + 1 : unitId}`;
  }
  const [head, ...rest] = unitId.split(":");
  const word = FAMILY_WORD[head] ?? "";
  const pathLike = rest.find((segment) => segment.includes("/"));
  const tail = pathLike ? pathLike.split("/").pop() ?? "" : rest.filter((segment) => segment && !/^\d+$/.test(segment)).pop() ?? head;
  return word ? `${tail} · ${word}` : tail || unitId;
}

/** 换一题 = 旧 nonce + 1；解析不出按 0 起算。 */
function llmNonce(unitId: string): number {
  return llmUnitNonce(unitId) ?? 0;
}

/** 回答框的提示按题型与判分口径给。 */
function answerPlaceholder(kind: ExerciseKind, mode: ExerciseGradingMode): string {
  if (mode === "rubric") return "用自己的话写出你的分析";
  if (kind === "change_localization") return "写出要改的文件与位置（行号或函数名）";
  if (kind === "impact_analysis") return "列出会受影响的调用点，并说明依据";
  return "写下你的回答";
}

export function PracticePage({ workspace, chat: t, visible }: { workspace: Workspace; chat: ScopedChatApi; visible: boolean }): ReactElement {
  const repositoryId = workspace.repositoryId;
  const navigate = useNavigate();
  const [summary, setSummary] = useState<PracticeSummary | null>(null);
  const [exercise, setExercise] = useState<Exercise | null>(null);
  const [text, setText] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 代码题工作副本；换题即重置。 */
  const [codeFiles, setCodeFiles] = useState<CodeEditorFile[]>([]);
  const [activeCodePath, setActiveCodePath] = useState("");
  /** 讲评为按需第二趟；提交的是被判版本，不是编辑器草稿 */
  const [submittedFiles, setSubmittedFiles] = useState<{ path: string; contents: string }[]>([]);
  const [explanation, setExplanation] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [result, setResult] = useState<ExerciseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** 最近一次出题失败的节点（单元 id + 引擎原话）：对应卡片转警示态。 */
  const [failedUnit, setFailedUnit] = useState<{ unitId: string; reason: string } | null>(null);
  const [source, setSource] = useState<SourcePayload | null>(null);
  const [modules, setModules] = useState<PracticeTheme[]>(loadPracticeThemes);
  const [activeModule, setActiveModule] = useState<string>(() => loadActiveTheme(repositoryId, modules));
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();

  useEffect(() => { savePracticeThemes(modules); }, [modules]);
  useEffect(() => { saveActiveTheme(repositoryId, activeModule); }, [repositoryId, activeModule]);

  /** 进度读取：tab 首次打开后读一次，成功时清旧错误；生成与提交后主动刷新。 */
  const everVisible = useEverVisible(visible);
  const refreshSummary = (): void => {
    api.getPractice(repositoryId).then((next) => { setSummary(next); setError(""); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取练习进度"));
  };
  useEffect(() => { if (everVisible) refreshSummary(); }, [repositoryId, everVisible]);

  // 出题分派：理解题走规则族，自定义主题走 LLM 族；LLM 题「换一题」是 variantNonce+1，旧题保留。
  const generate = async (targetUnitId?: string, variantNonce?: number): Promise<void> => {
    // 一次只发一趟，连点不并发 POST
    if (loading) return;
    setLoading(true); setError(""); setResult(null); setText(""); setSelectedIds([]);
    const isLlmFamily = activeModule !== COMPREHENSION_THEME_ID;
    const failingUnit = isLlmFamily ? `llm:${activeModule}:${variantNonce ?? 0}` : targetUnitId;
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
      setFailedUnit(null);
      t.setPracticeUnit(next.title);
      t.setPracticeExercise(next);
      showToast(`新练习 · ${exerciseKindLabel(next.kind)}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "无法生成练习";
      setError(message);
      if (failingUnit) setFailedUnit({ unitId: failingUnit, reason: message });
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

  useEffect(() => {
    const slot = exercise?.code;
    setCodeFiles(slot ? slot.files.map((file) => ({ ...file })) : []);
    setActiveCodePath(slot?.files[0]?.path ?? "");
  }, [exercise?.id]);

  const toggle = (id: string): void => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  /** 重复点同一 chip 不记事件；list 传入新增/删除时尚未提交的新列表。 */
  const switchModule = (id: string, list: PracticeTheme[] = modules): void => {
    if (id === activeModule) return;
    setActiveModule(id);
    emit(repositoryId, "module_switched", { from: activeModule, to: id, label: (list.find((item) => item.id === id)?.label ?? id).slice(0, 120) });
  };
  const submit = async (): Promise<void> => {
    if (!exercise) return;
    setLoading(true); setError("");
    // 提交动作先记；判分结果由 exercise_result 记
    emit(repositoryId, "exercise_submitted", { exercise_id: exercise.id, kind: exercise.kind, module: activeModule, target_unit: exercise.targetUnitId });
    try {
      const answer = exercise.inputMode === "multi_select" ? { selectedIds } : exercise.inputMode === "code" ? { files: codeFiles } : { text };
      const next = await api.submitExercise(repositoryId, exercise.id, answer);
      if (exercise.inputMode === "code") { setSubmittedFiles(codeFiles); setExplanation(""); }
      setResult(next);
      refreshSummary();
      t.pushMessage("practice", "agent", `判分完成：${next.passed ? "已通过" : "继续完善"}（${Math.round(next.score * 100)}%）· ${next.feedback}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法提交答案");
    } finally {
      setLoading(false);
    }
  };

  const explain = async (): Promise<void> => {
    if (!exercise || !submittedFiles.length) return;
    setExplaining(true); setError("");
    try {
      const next = await api.explainExercise(repositoryId, exercise.id, { files: submittedFiles });
      setExplanation(next.explanation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "讲评没走通");
    } finally {
      setExplaining(false);
    }
  };

  const isComprehensionChip = activeModule === COMPREHENSION_THEME_ID;
  const moduleMastery = (summary?.mastery ?? [])
    .filter((record) => isComprehensionChip ? !record.unitId.startsWith("llm:") : record.unitId.startsWith(`llm:${activeModule}:`))
    .sort((left, right) => (right.lastPracticedAt ?? "").localeCompare(left.lastPracticedAt ?? ""));
  const moduleLabel = modules.find((item) => item.id === activeModule)?.label ?? "未命名主题";
  const anchor = exercise?.anchors[0];
  /** 面板只渲染前 MAX_RENDER_LINES 行；锚点行在范围外就不能说「已高亮」。 */
  const anchorRenderable = anchor ? isLineRendered(anchor.line) : true;
  const codeNote = anchor
    ? anchorRenderable
      ? "相关代码已高亮"
      : `相关代码超出预览上限（第 ${anchor.line} 行）`
    : "生成练习后显示相关代码";
  const codeNoteTitle = anchor && !anchorRenderable ? `面板渲染前 ${MAX_RENDER_LINES} 行，该锚点在渲染范围之外` : undefined;
  const canSubmit = !loading && (exercise?.inputMode === "multi_select" ? selectedIds.length > 0 : exercise?.inputMode === "code" ? codeFiles.length > 0 : text.trim().length > 0);
  const activeCodeFile = codeFiles.find((file) => file.path === activeCodePath);
  /** 掌握度页顶只报均值：`PracticeSummary.mastery` 每条带 level。 */
  const masteryAvg = summary && summary.mastery.length
    ? `${(summary.mastery.reduce((sum, record) => sum + record.level, 0) / summary.mastery.length).toFixed(1)} / 5`
    : summary ? "暂无记录" : "读数未到";
  const repositoryName = workspace.repositoryPath.split("/").filter(Boolean).pop() ?? repositoryId;
  /** 判分后选项着色依据：matched+missing 为标准答案项，unexpected 为多选项。 */
  const expectedOptionIds = result && result.gradingMode === "set_match"
    ? new Set([...(result.matchedIds ?? []), ...(result.missingIds ?? [])])
    : null;
  const wrongOptionIds = new Set(result?.unexpectedIds ?? []);
  const moduleHint = modules.find((item) => item.id === activeModule)?.hint ?? "";

  return (
    <>
      <PageTopbar
        crumb={<>
          <b>{repositoryName}</b>
          <span className="faint">/</span>
          <span>练习评估</span>
          <span className="faint">·</span>
          <span title={summary ? `${summary.mastery.length} 个单元练过` : "练习进度还没读到"}>待复习 {summary ? <><b className="num-warn">{summary.dueReviews}</b> 个</> : "读数未到"}</span>
          <span className="faint">·</span>
          <span title={summary && summary.mastery.length ? `${summary.mastery.length} 个单元的平均掌握度` : "暂无答题记录"}>掌握度 {masteryAvg}</span>
        </>}
        showRailToggle
      />
      <MobileSwitcher labels={["练习主题", "练习上下文"]} active={paneActive} onSelect={setPaneActive} />
      <div className="page page-practice">
        <ColumnResizer field="filePaneWidth" label="列表栏" growOn="right" />

        <aside className={`practice-side ${paneClass(0)}`}>
          <PracticeThemes
            header="练习主题"
            modules={modules}
            activeId={activeModule}
            onSelectModule={switchModule}
            onRename={(id, label) => setModules(modules.map((item) => (item.id === id ? { ...item, label: label.trim() || "未命名主题" } : item)))}
            onAdd={(label) => {
              const id = `custom-${Date.now().toString(36)}`;
              const next = [...modules, { id, label, hint: "自定义主题 · 生成练习时由 LLM 出题", custom: true }];
              setModules(next);
              switchModule(id, next);
            }}
            onRemove={(id) => setModules(modules.filter((item) => item.id !== id))}
            onReset={() => { const next = PRACTICE_DEFAULT_THEMES.map((item) => ({ ...item })); setModules(next); switchModule(COMPREHENSION_THEME_ID, next); }}
          >
            {moduleHint ? <p className="field-note" title="主题可在「＋ 配置」里自定义">{moduleHint}</p> : null}
            <PracticeSectionLabel label="本主题已练" note={`${moduleMastery.length} 项`} tip="点卡片可按同一主题重新出题" />
            {moduleMastery.length ? (
              <div className="col">
                {moduleMastery.map((record) => (
                  <DoneCard
                    key={record.unitId}
                    record={record}
                    selected={exercise?.targetUnitId === record.unitId}
                    dueAt={result && result.targetUnitId === record.unitId ? result.review.dueAt : undefined}
                    failed={failedUnit?.unitId === record.unitId ? failedUnit.reason : null}
                    onPick={() => void(record.unitId.startsWith("llm:") ? generate(undefined, llmNonce(record.unitId)) : generate(record.unitId))}
                  />
                ))}
              </div>
            ) : (
              <p className="entry-empty" title="右侧「生成练习」出题">{isComprehensionChip ? "还没有练习记录。" : "这个主题还没有题。"}</p>
            )}
          </PracticeThemes>
        </aside>

        <div className={`practice-main ${paneClass(1)}`}>
          <div className="practice-wrap">
            {error ? (
              <div className="banner banner-danger">
                <Icon name="alert" size={14} />
                <span className="banner-text">{error}</span>
                {/* 产物与文件脱节类原因：出路是去导入页重跑 */}
                {/重新导入|已更新/.test(error) ? (
                  <span className="banner-actions"><button type="button" onClick={() => navigate("/import")}>去重新分析</button></span>
                ) : null}
              </div>
            ) : null}

            {!exercise && loading ? (
              <div className="card card-pad col">
                <div className="section-title">正在出题</div>
                <div className="phase active" title={isComprehensionChip ? "按代码结构出题，涉及具体代码时先验证题目可用" : "按这个主题出题"}>
                  <span className="phase-dot"><span className="spin"><Icon name="rotate" size={12} /></span></span>
                  <span className="fs-12">{isComprehensionChip ? "正在出题" : "正在按主题出题"}</span>
                </div>
                <div className="flow-skeleton" aria-hidden><span /><span /><span /></div>
              </div>
            ) : null}

            {!exercise && !loading ? (
              <div className="empty">
                <div className="empty-icon"><Icon name="practice" size={34} /></div>
                <div>{isComprehensionChip ? "这个主题还没有练习" : `「${moduleLabel}」还没有题`}</div>
                <button type="button" className="btn btn-accent" onClick={() => void generate()} disabled={loading} title={isComprehensionChip ? "按代码结构出题" : "按这个主题出题"}><Icon name="play" size={14} /> 生成练习</button>
              </div>
            ) : null}

            {exercise ? (
              <>
                <div className="exercise-head">
                  <span className="badge badge-neutral">{exerciseKindLabel(exercise.kind)}</span>
                  <span className="badge badge-info ellipsis" >目标单元 · {exercise.targetTitle || unitName(exercise.targetUnitId)}</span>
                  <span className="badge badge-neutral" title="难度档位由引擎按单元的结构复杂度给出（0–5）">难度 {exercise.difficulty}/5</span>
                  {result ? <span className={`badge ${result.passed ? "badge-ok" : "badge-danger"}`}>{result.passed ? "通过" : "未通过"} · {Math.round(result.score * 100)} 分</span> : null}
                </div>
                <h2 className="exercise-title">{exercise.title}</h2>

                {exercise.anchors.length ? (
                  <div className="row-wrap">
                    <span className="fs-11 faint">相关代码锚点：</span>
                    {exercise.anchors.map((item) => (
                      <span className="anchor-chip" key={`${item.path}:${item.line}`} title={`${item.path}:${item.line}${item.label ? ` · ${item.label}` : ""}`}>
                        <Icon name="file" size={12} />
                        {item.path.split("/").pop()}:{item.line}
                      </span>
                    ))}
                  </div>
                ) : null}

                <ExercisePrompt key={exercise.id} text={exercise.prompt} />

                <section className="card clip code-card">
                  <div className="code-context row between">
                    <span className="cc-name">{anchor ? `${anchor.path}:${anchor.line}` : "练习上下文"}</span>
                    <span className="fs-11 faint" title={codeNoteTitle}>{codeNote}</span>
                  </div>
                  <SourceView source={source} emptyHint="生成练习后显示题面对应的代码" />
                </section>

                <div className="col">
                  <div className="row between">
                    <span className="section-title">{exercise.inputMode === "code" ? "你的代码" : "你的回答"}</span>
                    <span className="fs-11 faint" title={`判分：${gradingLabel(exercise.gradingMode)}｜代码改过就要重新出题`}>{gradingLabel(exercise.gradingMode)}</span>
                  </div>

                  {exercise.inputMode === "multi_select" ? (
                    <div className="col">
                      {exercise.options?.map((option) => {
                        const expected = expectedOptionIds?.has(option.id) ?? false;
                        const cls = result ? (expected ? "correct" : wrongOptionIds.has(option.id) ? "wrong" : "") : selectedIds.includes(option.id) ? "checked" : "";
                        return (
                          <button
                            type="button"
                            key={option.id}
                            className={`option-row ${cls}`}
                            disabled={!!result}
                            onClick={() => toggle(option.id)}
                            title={result ? (expected ? (result.matchedIds?.includes(option.id) ? "标准答案项，你选了" : "标准答案项，你没选") : wrongOptionIds.has(option.id) ? "你多选的项" : "不在标准答案里，也没选") : undefined}
                          >
                            <span className="option-box">{cls === "correct" || cls === "checked" ? <Icon name="check" size={11} /> : null}</span>
                            <span className="grow col"><code>{option.label}</code>{option.detail ? <small className="fs-11 faint">{option.detail}</small> : null}</span>
                            {result && expected ? <span className="badge badge-ok push-right">正确项</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {exercise.inputMode === "code" && exercise.code ? (
                    <div className="col">
                      <p className="fs-11 faint" title="提交后运行测试判分">代码包</p>
                      {codeFiles.length > 1 ? (
                        <div className="tabs light" role="tablist" aria-label="下发代码文件">
                          {codeFiles.map((file) => (
                            <button
                              type="button"
                              key={file.path}
                              role="tab"
                              aria-selected={file.path === activeCodePath}
                              className={file.path === activeCodePath ? "tab active" : "tab"}
                              title={file.path}
                              onClick={() => setActiveCodePath(file.path)}
                            >
                              <Icon name="file" size={12} />
                              <code>{file.path.split("/").pop()}</code>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {activeCodeFile ? (
                        <CodeEditor
                          file={activeCodeFile}
                          language={exercise.code.language}
                          resetKey={`${exercise.id}:${activeCodePath}`}
                          ariaLabel={exercise.code.files.length > 1 ? "练习代码编辑器" : `编辑 ${activeCodePath}`}
                          onChange={(contents) => setCodeFiles((current) => current.map((file) => (file.path === activeCodePath ? { ...file, contents } : file)))}
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {exercise.inputMode !== "multi_select" && exercise.inputMode !== "code" ? (
                    <textarea
                      className="ans-textarea"
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                      rows={4}
                      aria-label="练习答案"
                      placeholder={answerPlaceholder(exercise.kind, exercise.gradingMode)}
                    />
                  ) : null}
                </div>

                <div className="row">
                  {result ? null : (
                    <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!canSubmit} title="提交会记一条审计">
                      {loading ? <span className="spin"><Icon name="rotate" size={15} /></span> : <Icon name="check" size={15} />}提交判分
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void(exercise.kind === "llm_rubric" ? generate(undefined, llmNonce(exercise.targetUnitId) + 1) : generate(exercise.targetUnitId))}
                    disabled={loading}
                    title={exercise.kind === "llm_rubric" ? "换一道新题，旧题与记录留着" : "按这个单元重新出题"}
                  ><Icon name="rotate" size={14} />换一题</button>
                </div>

                {result ? (
                  <GradedPanel exercise={exercise} result={result} explanation={explanation} explaining={explaining} onExplain={() => void explain()} onRedo={() => { setResult(null); setExplanation(""); setSubmittedFiles([]); }} />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function GradedPanel({ exercise, result, explanation, explaining, onExplain, onRedo }: { exercise: Exercise; result: ExerciseResult; explanation: string; explaining: boolean; onExplain: () => void; onRedo: () => void }): ReactElement {
  const optionLabel = (id: string): string => exercise.options?.find((item) => item.id === id)?.label ?? id;
  /** 逐条判定行两种来源：set_match 的 id 数组；execution 只有总体判定。 */
  const rows: { passed: boolean; label: string }[] = result.gradingMode === "execution"
    ? [{ passed: result.passed, label: result.passed ? "测试全部通过" : "测试没有全部通过" }]
    : result.gradingMode === "set_match"
      ? [
          ...(result.matchedIds ?? []).map((id) => ({ passed: true, label: `选中 ${optionLabel(id)}` })),
          ...(result.missingIds ?? []).map((id) => ({ passed: false, label: `漏选 ${optionLabel(id)}` })),
          ...(result.unexpectedIds ?? []).map((id) => ({ passed: false, label: `多选 ${optionLabel(id)}` }))
        ]
      : [];
  const sm2 = [`间隔 ${result.review.intervalDays} 天`, `第 ${result.review.repetitions} 次复习`];
  if (result.review.lastReviewedAt) sm2.push(`上次作答 ${dateText(result.review.lastReviewedAt)}`);

  return (
    <div className={`feedback-panel ${result.passed ? "feedback-pass" : "feedback-fail"}`}>
      <div className="feedback-head">
        <Icon name={result.passed ? "check" : "alert"} size={16} />
        {result.passed ? "通过" : "未通过"} · {Math.round(result.score * 100)} 分
      </div>

      <p>{result.feedback}</p>

      {rows.length ? (
        <div className="test-table" title={result.gradingMode === "execution" ? "只显示通过数与失败数" : "选项与标准答案逐项比对"}>
          {rows.map((row, index) => (
            <div className={`test-row ${row.passed ? "pass" : "fail"}`} key={`${row.label}-${index}`}>
              <span className="t-status">{row.passed ? "通过" : "未通过"}</span>
              <span>{row.label}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="due-note" title={sm2.join(" · ")}>
        <Icon name="rotate" size={13} /> 下次复习 <b>{dateText(result.review.dueAt)}</b>
      </div>

      <div className="row">
        {result.passed ? null : <button type="button" className="btn btn-ghost btn-sm" onClick={onRedo} title="收起判分结果，答案留着可再交">再试一次</button>}
        {exercise.inputMode === "code" && !explanation ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onExplain} disabled={explaining} title="需要一次模型请求">
            {explaining ? <span className="spin"><Icon name="rotate" size={14} /></span> : <Icon name="zap" size={14} />}讲解这版
          </button>
        ) : null}
      </div>

      {explanation ? (
        <div className="msg msg-agent full-width">
          <div className="msg-bubble full-width"><Markdown content={explanation} /></div>
        </div>
      ) : null}
    </div>
  );
}

/** 已练卡片：报掌握度档位；复习日期只存在于判分结果的 review。 */
function DoneCard({ record, selected, dueAt, failed, onPick }: { record: MasteryRecord; selected: boolean; dueAt?: string; failed: string | null; onPick: () => void }): ReactElement {
  const last = record.lastPracticedAt ? dateText(record.lastPracticedAt) : "";
  return (
    <button
      type="button"
      className={`done-card${selected ? " selected" : ""}${failed ? " failed" : ""}`}
      title={failed ? `刚才这个节点出题失败：${failed}` : `${record.unitId} · ${record.attempts} 次练习里 ${record.successes} 次通过 · 点击按这个单元重新出题`}
      onClick={onPick}
    >
      <div className="d-head">
        <span className="grow">{unitName(record.unitId)}</span>
        <span className={`d-score ${record.successes > 0 ? "pass" : "fail"}`}>{record.level}/5</span>
      </div>
      <div className="d-due">{failed ? "刚才出题没成功 · 悬停看原因" : dueAt ? `下次复习 ${dateText(dueAt)}` : last ? `上次练习 ${last}` : "尚无练习记录"}</div>
    </button>
  );
}

/** 题面：超 6 行或 240 字才出展开按钮；折叠状态不跨题保留。 */
function ExercisePrompt({ text }: { text: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const long = text.length > 240 || text.split("\n").length > 6;
  if (!long) return <p className="exercise-prompt">{text}</p>;
  return (
    <>
      <p className={`exercise-prompt${open ? "" : " clamped"}`}>{text}</p>
      <button type="button" className="btn btn-ghost btn-sm prompt-toggle" aria-expanded={open} onClick={() => setOpen((prev) => !prev)}>
        {open ? "收起" : "展开"}
      </button>
    </>
  );
}
