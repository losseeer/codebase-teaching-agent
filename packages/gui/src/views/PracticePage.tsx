import { ExerciseGradingMode, ExerciseKind, ExerciseResult, exerciseTypeOf, PracticeSummary } from "@codebase-tutor/domain";
import type { Exercise, ExerciseBankEntry, ExerciseType } from "@codebase-tutor/domain";

import {useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { CodeEditor, type CodeEditorFile } from "../source/CodeEditor";
import { api, type Workspace } from "../api/client";
import type { ScopedChatApi } from "../agent/scopedChatApi";
import { Markdown } from "../agent/Markdown";
import { dateText, exerciseKindLabel } from "../ui/labels";
import { MobileSwitcher, PageTopbar, useMobilePanes } from "./WorkspaceChrome";
import { ColumnResizer } from "../ui/ColumnResizer";
import { PracticeThemes, PracticeTypePicker, PracticeBank } from "./PracticeThemes";
import { Icon } from "../ui/icons";
import { emit } from "../journal";
import { failureText, showToast } from "../ui/toast";
import { useEverVisible } from "../ui/useEverVisible";
import { DangerDialog } from "../ui/DangerDialog";
import { loadActiveTheme, loadPracticeThemes, loadPracticeType, saveActiveTheme, savePracticeThemes, savePracticeType, ALL_THEME_ID, PRACTICE_DEFAULT_THEMES, type PracticeTheme } from "./practiceThemeState";
import { SourceView, isLineRendered, MAX_RENDER_LINES, type SourcePayload } from "../source/SourceView";

// 练习评估工作区两栏：左 = 题型 / 考察知识 / 题库，右 = 出题与判分。
// 题型决定链路（理解题吃静态分析、分析题走 rubric、设计题进沙箱），主题只筛目标单元。
// 顶栏只报 getPractice 的真读数；出题中不画假进度。

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
  /** 出题失败那趟顺手读到的成本读数：只在额度真到线时多给一个去向。 */
  const [budgetTight, setBudgetTight] = useState(false);
  /** 题库：这个仓存着的题 + 复习排期，纯读不花钱。 */
  const [bank, setBank] = useState<ExerciseBankEntry[]>([]);
  const [pendingDelete, setPendingDelete] = useState<Exercise | null>(null);
  const [source, setSource] = useState<SourcePayload | null>(null);
  /** 题面吃多段代码时，正在看哪一段。 */
  const [anchorIndex, setAnchorIndex] = useState(0);
  const [modules, setModules] = useState<PracticeTheme[]>(loadPracticeThemes);
  const [activeModule, setActiveModule] = useState<string>(() => loadActiveTheme(repositoryId, modules));
  const [exerciseType, setExerciseType] = useState<ExerciseType>(loadPracticeType);
  const [designKind, setDesignKind] = useState<"patch_edit" | "author_function">("patch_edit");
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();

  useEffect(() => { savePracticeThemes(modules); }, [modules]);
  useEffect(() => { saveActiveTheme(repositoryId, activeModule); }, [repositoryId, activeModule]);
  useEffect(() => { savePracticeType(exerciseType); }, [exerciseType]);

  /** 题型 → 具体题型：理解题交给引擎按掌握度轮换，分析题与设计题点名。主题只筛目标。 */
  const kind: ExerciseKind | undefined = exerciseType === "analysis" ? "llm_rubric" : exerciseType === "design" ? designKind : undefined;
  const theme = activeModule === ALL_THEME_ID ? undefined : modules.find((item) => item.id === activeModule);
  /** 分析题与设计题都靠主题选素材；只选了「全仓」时不给发。 */
  const needsTheme = exerciseType !== "comprehension" && !theme;

  /** 进度读取：tab 首次打开后读一次，成功时清旧错误；生成与提交后主动刷新。 */
  const everVisible = useEverVisible(visible);
  const refreshSummary = (): void => {
    api.getPractice(repositoryId).then((next) => { setSummary(next); setError(""); }).catch((reason: unknown) => setError(failureText("练习进度读取失败", reason)));
  };
  useEffect(() => { if (everVisible) refreshSummary(); }, [repositoryId, everVisible]);

  /** 题库读一次：题与复习排期都在引擎侧。 */
  const refreshBank = (): void => {
    api.listExercises(repositoryId).then((next) => setBank(next.exercises)).catch((reason: unknown) => setError(failureText("题库读取失败", reason)));
  };
  useEffect(() => { if (everVisible) refreshBank(); }, [repositoryId, everVisible]);

  // 出题：题型决定链路，主题只筛目标单元；「换一题」= 换目标或换 nonce，旧题留在题库里。
  const generate = async (targetUnitId?: string, variantNonce?: number): Promise<void> => {
    // 一次只发一趟，连点不并发 POST
    if (loading) return;
    setLoading(true); setError(""); setResult(null); setText(""); setSelectedIds([]); setBudgetTight(false);
    try {
      const next = await api.createExercise(repositoryId, {
        ...(kind ? { kind } : {}),
        ...(theme ? { tag: theme.label, tagId: theme.id } : {}),
        ...(targetUnitId ? { targetUnitId } : {}),
        ...(variantNonce !== undefined ? { variantNonce } : {})
      });
      setExercise(next);
      t.setPracticeUnit(next.title);
      t.setPracticeExercise(next);
      refreshBank();
      showToast(`新练习 · ${exerciseKindLabel(next.kind)}`);
    } catch (reason) {
      setError(failureText("出题失败", reason));
      // 额度到线是出题失败最常见的一种：读一次免费的成本读数，只在真到线时给出去向，界面上不写原因
      api.getCost(repositoryId).then((cost) => setBudgetTight(cost.mode === "degraded")).catch(() => { /* 读数没到就不给入口 */ });
    } finally {
      setLoading(false);
    }
  };

  /** 题面吃多段代码时只预览选中的那一段，切段就是换一次锚点。 */
  const shownIndex = exercise ? Math.min(anchorIndex, Math.max(0, exercise.anchors.length - 1)) : 0;
  const anchor = exercise?.anchors[shownIndex];
  useEffect(() => {
    if (!anchor) { setSource(null); return; }
    let current = true;
    api.getSource(repositoryId, anchor.path, anchor.line).then((next) => { if (current) setSource(next); }).catch(() => { if (current) setSource(null); });
    return () => { current = false; };
  }, [anchor?.path, anchor?.line, repositoryId]);

  useEffect(() => {
    const slot = exercise?.code;
    setAnchorIndex(0);
    setCodeFiles(slot ? slot.files.map((file) => ({ ...file })) : []);
    setActiveCodePath(slot?.files[0]?.path ?? "");
  }, [exercise?.id]);

  /** 判分结果常落在首屏之外：出来时只滚到刚好看得到它，不替用户决定看什么。 */
  const graded = useRef<HTMLDivElement>(null);
  useEffect(() => { if (result) graded.current?.scrollIntoView({ block: "nearest" }); }, [result]);

  const toggle = (id: string): void => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  /** 换主题 / 换题型 = 换题面来源：上一道题的作答与判分结果不能留在这一栏里。 */
  const clearExercise = (): void => {
    setExercise(null); setResult(null); setText(""); setSelectedIds([]); setAnchorIndex(0);
    t.setPracticeUnit(""); t.setPracticeExercise(null);
  };
  /** 重复点同一 chip 不记事件；list 传入新增/删除时尚未提交的新列表。 */
  const switchModule = (id: string, list: PracticeTheme[] = modules): void => {
    if (id === activeModule) return;
    setActiveModule(id);
    clearExercise();
    emit(repositoryId, "module_switched", { from: activeModule, to: id, label: (list.find((item) => item.id === id)?.label ?? id).slice(0, 120) });
  };
  /** 换题型同样清场：题面形态变了，旧题留在这一栏就是错位。 */
  const switchType = (next: ExerciseType): void => {
    if (next === exerciseType) return;
    setExerciseType(next);
    clearExercise();
  };
  /** 从题库打开：直接摆出存着的那道题，不重新出题、不花钱；左栏跟着切到这道题的题型与主题。 */
  const openBank = (next: Exercise): void => {
    const type = exerciseTypeOf(next.kind);
    setExerciseType(type);
    if (type === "design") setDesignKind(next.kind === "author_function" ? "author_function" : "patch_edit");
    const hit = next.tag ? modules.find((item) => item.label === next.tag) : undefined;
    if (hit) setActiveModule(hit.id);
    setExercise(next); setResult(null); setText(""); setSelectedIds([]); setAnchorIndex(0); setError("");
    t.setPracticeUnit(next.title); t.setPracticeExercise(next);
  };
  /** 删题：题与复习排期一起删；握在手里的正是它时一并清掉。 */
  const removeExercise = async (target: Exercise): Promise<void> => {
    setPendingDelete(null);
    try {
      await api.deleteExercise(repositoryId, target.id);
    } catch (reason) {
      setError(failureText("删除失败", reason));
      return;
    }
    if (exercise?.id === target.id) clearExercise();
    refreshBank(); refreshSummary();
    showToast("已从题库删除");
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
      setError(failureText("答案提交失败", reason));
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

  const themeLabel = theme?.label ?? "全仓";
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
  const themeHint = theme?.hint ?? "";
  /** 空态文案里的题型短名。 */
  const typeWord = exerciseType === "analysis" ? "分析" : exerciseType === "design" ? "设计" : "理解";

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
          <PracticeTypePicker value={exerciseType} onChange={switchType} designKind={designKind} onDesignKind={(next) => { setDesignKind(next); clearExercise(); }} />
          <PracticeThemes
            header="考察知识"
            modules={modules}
            activeId={activeModule}
            onSelectModule={switchModule}
            onRename={(id, label) => setModules(modules.map((item) => (item.id === id ? { ...item, label: label.trim() || "未命名主题" } : item)))}
            onAdd={(label) => {
              const id = `custom-${Date.now().toString(36)}`;
              const next = [...modules, { id, label, hint: "自建考察主题 · 出题时按它筛代码", custom: true }];
              setModules(next);
              switchModule(id, next);
            }}
            onRemove={(id) => setModules(modules.filter((item) => item.id !== id))}
            onReset={() => { const next = PRACTICE_DEFAULT_THEMES.map((item) => ({ ...item })); setModules(next); switchModule(ALL_THEME_ID, next); }}
          >
            {themeHint ? <p className="field-note" title="主题可在配置面板里改名 / 新增 / 删除">{themeHint}</p> : null}
            {needsTheme ? <p className="field-note warn" title="分析题与设计题按主题挑代码">这个题型要先选一个考察主题。</p> : null}
          </PracticeThemes>
          <PracticeBank entries={bank} activeId={exercise?.id} onOpen={openBank} onDelete={setPendingDelete} />
          {pendingDelete ? (
            <DangerDialog
              title="从题库删除"
              body={`「${pendingDelete.title}」与它的复习排期会一起删掉；历史练习记录保留。`}
              deleteLabel="删除这道题"
              onDelete={() => void removeExercise(pendingDelete)}
              onClose={() => setPendingDelete(null)}
            />
          ) : null}
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
                {budgetTight ? (
                  <span className="banner-actions"><button type="button" onClick={() => navigate("/insights")}>去成本监控</button></span>
                ) : null}
              </div>
            ) : null}

            {!exercise && loading ? (
              <div className="card card-pad col">
                <div className="section-title">正在出题</div>
                <div className="phase active" title={exerciseType === "design" ? "设计题会先在沙箱里自证再下发" : "按代码结构与主题出题"}>
                  <span className="phase-dot"><span className="spin"><Icon name="rotate" size={12} /></span></span>
                  <span className="fs-12">{theme ? `正在按「${themeLabel}」出题` : "正在出题"}</span>
                </div>
                <div className="flow-skeleton" aria-hidden><span /><span /><span /></div>
              </div>
            ) : null}

            {!exercise && !loading ? (
              <div className="empty">
                <div className="empty-icon"><Icon name="practice" size={34} /></div>
                <div>{needsTheme ? "先选一个考察主题" : `还没有${typeWord}题`}</div>
                <button type="button" className="btn btn-accent" onClick={() => void generate()} disabled={loading || needsTheme} title={needsTheme ? "分析题与设计题按主题挑代码" : "按当前题型与主题出题"}><Icon name="play" size={14} /> 生成练习</button>
              </div>
            ) : null}

            {exercise ? (
              <div className="practice-cols">
                <div className="practice-topic">
                  <div className="exercise-meta">
                    <span>{exerciseKindLabel(exercise.kind)}</span>
                    <span aria-hidden>·</span>
                    <span title="按代码复杂度定档">难度 {exercise.difficulty}/5</span>
                  </div>
                  <h2 className="exercise-title">{exercise.title}</h2>

                  {exercise.anchors.length > 1 ? (
                    <div className="row-wrap">
                      <span className="fs-11 faint">题面用到的代码：</span>
                      {exercise.anchors.map((item, index) => (
                        <button
                          type="button"
                          key={`${item.path}:${item.line}`}
                          className="anchor-chip"
                          aria-pressed={index === shownIndex}
                          title={`${item.path}:${item.line}`}
                          onClick={() => setAnchorIndex(index)}
                        >
                          <Icon name="file" size={12} />
                          {item.path.split("/").pop()}:{item.line}
                        </button>
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
                </div>

                <div className="practice-answer">
                  <div className="row between">
                    <span className="section-title">{exercise.inputMode === "code" ? "你的代码" : "你的回答"}</span>
                    <span className="fs-11 faint" title="改过代码后要重新出题">{gradingLabel(exercise.gradingMode)}</span>
                  </div>

                  {exercise.inputMode === "multi_select" ? (
                    <div className="col">
                      {exercise.options?.map((option) => {
                        const expected = expectedOptionIds?.has(option.id) ?? false;
                        const picked = selectedIds.includes(option.id);
                        const cls = result ? (expected ? "correct" : wrongOptionIds.has(option.id) ? "wrong" : "") : "";
                        const note = result ? (expected ? (picked ? "标准答案，已选" : "标准答案，漏选") : picked ? "多选了这一项" : null) : null;
                        return (
                          <button
                            type="button"
                            key={option.id}
                            className={`option-row ${cls}${picked ? " picked" : ""}`}
                            disabled={!!result}
                            onClick={() => toggle(option.id)}
                            title={note ?? undefined}
                          >
                            <span className="option-box">{picked ? <Icon name="check" size={11} /> : null}</span>
                            <span className="grow col"><code>{option.label}</code>{option.detail ? <small className="fs-11 faint">{option.detail}</small> : null}</span>
                            {result && expected && !picked ? <span className="badge badge-warn push-right">漏选</span> : null}
                            {result && !expected && picked ? <span className="badge badge-danger push-right">多选</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {exercise.inputMode === "code" && exercise.code ? (
                    <div className="col">
                      <p className="fs-11 faint">要改的文件</p>
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
                      rows={8}
                      aria-label="练习答案"
                      placeholder={answerPlaceholder(exercise.kind, exercise.gradingMode)}
                    />
                  ) : null}

                  {result ? (
                    <div ref={graded}>
                      <GradedPanel exercise={exercise} result={result} explanation={explanation} explaining={explaining} onExplain={() => void explain()} onRedo={() => { setResult(null); setExplanation(""); setSubmittedFiles([]); }} />
                    </div>
                  ) : null}

                  <div className="practice-actions">
                    {result ? null : (
                      <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!canSubmit}>
                        {loading ? <span className="spin"><Icon name="rotate" size={15} /></span> : <Icon name="check" size={15} />}提交判分
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => void(exercise.kind === "llm_rubric" ? generate(undefined, llmNonce(exercise.targetUnitId) + 1) : generate(exercise.targetUnitId))}
                      disabled={loading}
                      title={exercise.kind === "llm_rubric" ? "换一题不影响旧题记录" : "按这段代码再出一题"}
                    ><Icon name="rotate" size={14} />换一题</button>
                  </div>
                </div>
              </div>
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
