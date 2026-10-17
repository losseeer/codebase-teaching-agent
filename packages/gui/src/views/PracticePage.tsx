import { useEffect, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { CodeEditor, type CodeEditorFile } from "./CodeEditor";
import type { Exercise, ExerciseGradingMode, ExerciseKind, ExerciseResult, MasteryRecord, PracticeSummary } from "@codebase-tutor/shared";
import { api, type Workspace } from "../api/client";
import type { ScopedChatApi } from "../agent/useScopedChat";
import { Markdown } from "../agent/Markdown";
import { dateText, exerciseKindLabel } from "./helpers";
import { MobileSwitcher, PageTopbar, useMobilePanes } from "./WorkspaceChrome";
import { ColumnResizer } from "../ui/ColumnResizer";
import { ModulesPane, ModuleSectionLabel } from "../modules/ModulesPane";
import { Icon } from "../ui/icons";
import { emit } from "../journal";
import { showToast } from "../modules/toast";
import { useEverVisible } from "../ui/useEverVisible";
import { loadActiveModule, loadPracticeModules, saveActiveModule, savePracticeModules, COMPREHENSION_MODULE_ID, PRACTICE_DEFAULT_MODULES, type KnowledgeModule } from "../modules/local-state";
import { SourceView, isLineRendered, MAX_RENDER_LINES, type SourcePayload } from "../source/SourceView";

/**
  练习评估工作区（对齐 docs/ui-prototype/js/pages.js 的 `practicePage` L644-900 + pages.css L227-317，两栏）：
  - 顶栏 `PageTopbar`：仓名 · 待复习 N 个 · 掌握度 x/5（只有 `api.getPractice` 的真读数，没读到就明说）
  - 左 `.practice-side`：ModulesPane（主题 chips + 配置）→ 本模块已练卡片（`.done-card`）→ 防泄题脚注
  - 右 `.practice-main > .practice-wrap`：idle 空态 → generating 的 `.phase` 读数 → `.exercise-head` 徽章 +
    `.exercise-title` + `.anchor-chip` + `.exercise-prompt` → 按 `inputMode` 给作答件 → 判分后 `.feedback-panel`

  两处「不照抄原型」是有意保留的判断：原型的假进度（每 800ms 推进一个节点）与假分数（写死 2 / 3.8 / 日期）都不搬——
  我们只有一个 `await`，所以 generating 只说「正在出题」；判分口径逐字取自 `result.gradingMode` +
  `automatic` + `feedbackSource`，复习读数只取 `result.review` 里真存在的字段。
  */

/** 作答前也要能说清「这一题怎么判」：口径与判分后 `.grade-source` 那一行同源，不另起一套说法。 */
function gradingLabel(mode: ExerciseGradingMode): string {
  // 2026-10-14 起 `execution` 指的是「沙箱真跑那组冻结测试」，不再是旧的受限表达式求值
  if (mode === "execution") return "沙箱跑测试判分";
  if (mode === "rubric") return "rubric 细则判分（LLM 比对参考答案）";
  return "集合精确匹配";
}

/** 判分来源那一行要说实话：`automatic` 与 `feedbackSource` 决定模型到底有没有参与结论。 */
function gradeSource(result: ExerciseResult): { label: string; detail: string } {
  const automatic = result.automatic ? "automatic：模型不参与判分结论" : "非 automatic：结论里有模型成分";
  if (result.gradingMode === "execution") {
    return { label: `沙箱真跑冻结测试${result.automatic ? "（automatic）" : ""}`, detail: `${automatic}。沙箱只回「通过/失败」计数，逐条断言名不下发到界面，具体计数见上面那句反馈。` };
  }
  if (result.gradingMode === "rubric") {
    return { label: "rubric（LLM 比对参考答案）", detail: `${automatic}。评分细则与参考答案由出题模型给出，判分模型逐维比对学习者的原文。` };
  }
  return {
    label: "set_match（集合精确匹配）",
    detail: `${automatic}。选项 id 与标准答案逐个比对；反馈措辞${result.feedbackSource === "llm_polished" ? "由 LLM 润色过（结论不变）" : "出自规则原文"}。`
  };
}

/** LLM 出题单元 id 的版本号段（`llm:<tagId>:<nonce>`）；解析不出返回 null，两处判据共用。 */
function llmUnitNonce(unitId: string): number | null {
  const nonce = Number(unitId.split(":")[2] ?? 0);
  return Number.isFinite(nonce) ? nonce : null;
}

/** 规则题单元 id 的族别段 → 中文短名（单元 id 第一段是 `impact` / `workflow` / `implementation` 或 `change-localization`）。 */
const FAMILY_WORD: Record<string, string> = { impact: "影响面", workflow: "流程", implementation: "实现", change: "定位" };

function unitName(unitId: string): string {
  // LLM 出题单元 id 形如 llm:<tagId>:<nonce>，展示为主题练习序号
  if (unitId.startsWith("llm:")) {
    const nonce = llmUnitNonce(unitId);
    return `主题练习 #${nonce !== null ? nonce + 1 : unitId}`;
  }
  const [head, ...rest] = unitId.split(":");
  const word = FAMILY_WORD[head] ?? FAMILY_WORD[head.split("-")[0] ?? head] ?? "";
  // 单元 id 里最像路径的那一段取文件名；没有路径就取最后一段非纯数字（否则整卡只剩一个「233」）
  const pathLike = rest.find((segment) => segment.includes("/"));
  const tail = pathLike ? pathLike.split("/").pop() ?? "" : rest.filter((segment) => segment && !/^\d+$/.test(segment)).pop() ?? head;
  return word ? `${tail} · ${word}` : tail || unitId;
}

/** 换一题 = 旧 nonce + 1；解析不出按 0 起算。 */
function llmNonce(unitId: string): number {
  return llmUnitNonce(unitId) ?? 0;
}

/** 回答框的提示随题型走：按题型给口径，不能给一个「预测返回值」那种已经把题型删掉的旧说法。 */
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
  /** 代码题的工作副本：练习一换就整份重置成引擎下发的那一组文件（`exercise.code.files`） */
  const [codeFiles, setCodeFiles] = useState<CodeEditorFile[]>([]);
  const [activeCodePath, setActiveCodePath] = useState("");
  /** 讲评是按需的第二趟：只在**点过一次之后**才出现，且发的仍是被判的那一版代码（不是当前编辑器里的草稿） */
  const [submittedFiles, setSubmittedFiles] = useState<{ path: string; contents: string }[]>([]);
  const [explanation, setExplanation] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [result, setResult] = useState<ExerciseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** 刚才哪个节点出题失败了（单元 id + 引擎原话）：那个节点转警示态，别让人反复撞同一堵墙。 */
  const [failedUnit, setFailedUnit] = useState<{ unitId: string; reason: string } | null>(null);
  const [source, setSource] = useState<SourcePayload | null>(null);
  const [modules, setModules] = useState<KnowledgeModule[]>(loadPracticeModules);
  const [activeModule, setActiveModule] = useState<string>(() => loadActiveModule("practice", repositoryId, modules));
  const [paneActive, paneClass, setPaneActive] = useMobilePanes();

  useEffect(() => { savePracticeModules(modules); }, [modules]);
  useEffect(() => { saveActiveModule("practice", repositoryId, activeModule); }, [repositoryId, activeModule]);

  /** 进度读取：成功也要把旧的错误清掉——原来错误一旦挂上就一直留在面板里，重新拉好之后还在「无法读取练习进度」。
      只在「这个 tab 被打开过」之后读一次（常驻挂载的隐藏面板不必替用户查库）；
      生成与提交后仍按原路 `refreshSummary()` 主动刷新。 */
  const everVisible = useEverVisible(visible);
  const refreshSummary = (): void => {
    api.getPractice(repositoryId).then((next) => { setSummary(next); setError(""); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取练习进度"));
  };
  useEffect(() => { if (everVisible) refreshSummary(); }, [repositoryId, everVisible]);

  // 出题分派：活动 chip = 程序理解题 → 规则出题族；自定义主题 chip → LLM 出题族（family 对用户不可见）。
  // 「换一题」对 LLM 题走 variantNonce+1（出新题，旧题保留）；对规则题按 targetUnitId 重出。
  const generate = async (targetUnitId?: string, variantNonce?: number): Promise<void> => {
    setLoading(true); setError(""); setResult(null); setText(""); setSelectedIds([]);
    const isLlmFamily = activeModule !== COMPREHENSION_MODULE_ID;
    // 失败时把「刚才点的那个节点」记下来：卡片转成警示态并带上原因，用户不必再撞第二次
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
  /** 模块切换是设计文档第 8 章点名要可查的操作；id 未变（重复点同一 chip）不记，避免假轨迹。
      `list` 供「新增/删除模块」路径传入尚未提交的新列表——否则 label 会取到旧值。 */
  const switchModule = (id: string, list: KnowledgeModule[] = modules): void => {
    if (id === activeModule) return;
    setActiveModule(id);
    emit(repositoryId, "module_switched", { from: activeModule, to: id, label: (list.find((item) => item.id === id)?.label ?? id).slice(0, 120) });
  };
  const submit = async (): Promise<void> => {
    if (!exercise) return;
    setLoading(true); setError("");
    // 提交动作先记（用户做了什么），判分结果是引擎侧的事，落在 journal 的 exercise_result
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

  const isComprehensionChip = activeModule === COMPREHENSION_MODULE_ID;
  const moduleMastery = (summary?.mastery ?? [])
    .filter((record) => isComprehensionChip ? !record.unitId.startsWith("llm:") : record.unitId.startsWith(`llm:${activeModule}:`))
    .sort((left, right) => (right.lastPracticedAt ?? "").localeCompare(left.lastPracticedAt ?? ""));
  const moduleLabel = modules.find((item) => item.id === activeModule)?.label ?? "未命名模块";
  const anchor = exercise?.anchors[0];
  /** 与代码教学同一条规矩：面板只渲染前 MAX_RENDER_LINES 行，锚点行落在范围外就不能说「已高亮」。 */
  const anchorRenderable = anchor ? isLineRendered(anchor.line) : true;
  const codeNote = anchor
    ? anchorRenderable
      ? "相关代码已高亮"
      : `相关代码超出预览上限（第 ${anchor.line} 行）`
    : "生成练习后显示相关代码";
  const codeNoteTitle = anchor && !anchorRenderable ? `面板渲染前 ${MAX_RENDER_LINES} 行，该锚点在渲染范围之外` : undefined;
  const canSubmit = !loading && (exercise?.inputMode === "multi_select" ? selectedIds.length > 0 : exercise?.inputMode === "code" ? codeFiles.length > 0 : text.trim().length > 0);
  const activeCodeFile = codeFiles.find((file) => file.path === activeCodePath);
  /** 掌握度只有均值可报：`PracticeSummary.mastery` 每条带 level，页顶要的是一个数。 */
  const masteryAvg = summary && summary.mastery.length
    ? `${(summary.mastery.reduce((sum, record) => sum + record.level, 0) / summary.mastery.length).toFixed(1)} / 5`
    : summary ? "暂无记录" : "读数未到";
  const repositoryName = workspace.repositoryPath.split("/").filter(Boolean).pop() ?? repositoryId;
  /** 判分后的选项着色只认这三个真数组：`matched`+`missing` 是标准答案项，`unexpected` 是多选的项。 */
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
          <span title={summary ? `待复习条目取自引擎的复习排期（dueAt 已到）· ${summary.mastery.length} 个单元有练习记录` : "练习进度还没读到"}>待复习 {summary ? <><b className="num-warn">{summary.dueReviews}</b> 个</> : "读数未到"}</span>
          <span className="faint">·</span>
          <span title={summary && summary.mastery.length ? `${summary.mastery.length} 个单元掌握度的平均值，档位 0–5` : "掌握度来自 journal 回读，没有记录就不报数"}>掌握度 {masteryAvg}</span>
        </>}
        showRailToggle
      />
      <MobileSwitcher labels={["练习模块", "练习上下文"]} active={paneActive} onSelect={setPaneActive} />
      <div className="page page-practice">
        <ColumnResizer field="filePaneWidth" label="列表栏" growOn="right" />

        <aside className={`practice-side ${paneClass(0)}`}>
          <ModulesPane
            where="practice"
            header="练习模块"
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
            onReset={() => { const next = PRACTICE_DEFAULT_MODULES.map((item) => ({ ...item })); setModules(next); switchModule(COMPREHENSION_MODULE_ID, next); }}
          >
            {moduleHint ? <p className="field-note" title="主题可在「＋ 配置」里自定义">{moduleHint}</p> : null}
            <ModuleSectionLabel label="本模块已练" note={`${moduleMastery.length} 项`} tip="读数由 journal 回读；点卡片按这个单元重新出题" />
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
            <p className="fs-11 faint stretch-end" title="防止对话绕过题面拿到标准答案：判分答案与锚点都不进练习侧上下文">练习侧不给模型 read_file</p>
          </ModulesPane>
        </aside>

        <div className={`practice-main ${paneClass(1)}`}>
          <div className="practice-wrap">
            {error ? (
              <div className="banner banner-danger">
                <Icon name="alert" size={14} />
                <span className="banner-text">{error}</span>
                {/* 「重新导入 / 源码已更新」这两类原因是产物与实文件脱节，出路只有一条：去导入页重跑 */}
                {/重新导入|已更新/.test(error) ? (
                  <span className="banner-actions"><button type="button" onClick={() => navigate("/import")}>去重新分析</button></span>
                ) : null}
              </div>
            ) : null}

            {!exercise && loading ? (
              <div className="card card-pad col">
                <div className="section-title">正在出题</div>
                <div className="phase active" title={isComprehensionChip ? "族别由引擎决定：静态分析出理解题，命中代码单元时由模型出题并在沙箱两跑自证" : "LLM 按这个主题出题，模型可以拒题"}>
                  <span className="phase-dot"><span className="spin"><Icon name="rotate" size={12} /></span></span>
                  <span className="fs-12">{isComprehensionChip ? "引擎出题中" : "LLM 出题中"}</span>
                </div>
                <div className="flow-skeleton" aria-hidden><span /><span /><span /></div>
              </div>
            ) : null}

            {!exercise && !loading ? (
              <div className="empty">
                <div className="empty-icon"><Icon name="practice" size={34} /></div>
                <div>{isComprehensionChip ? "这个模块还没有练习" : `「${moduleLabel}」还没有题`}</div>
                <button type="button" className="btn btn-accent" onClick={() => void generate()} disabled={loading} title={isComprehensionChip ? "静态分析即时出题；命中代码单元时由模型出题并在沙箱两跑自证" : "LLM 按这个主题出题，模型可以拒题"}><Icon name="play" size={14} /> 生成练习</button>
              </div>
            ) : null}

            {exercise ? (
              <>
                <div className="exercise-head">
                  <span className="badge badge-neutral">{exerciseKindLabel(exercise.kind)}</span>
                  <span className="badge badge-info ellipsis" title={`单元 id ${exercise.targetUnitId}`}>目标单元 · {exercise.targetTitle || unitName(exercise.targetUnitId)}</span>
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

                <p className="exercise-prompt">{exercise.prompt}</p>

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
                    <span className="fs-11 faint" title={`判分口径：${gradingLabel(exercise.gradingMode)}｜代码版本 ${exercise.contentVersion.slice(0, 14)}，代码改过就重出题`}>{gradingLabel(exercise.gradingMode)}</span>
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
                      <p className="fs-11 faint" title="提交后在沙箱跑冻结测试：automatic，模型不参与判分">下发代码包</p>
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

/** 判完之后的一个节点：结论 + 判分口径 + 逐条判定行 + SM-2 调度 + 重做 / 按需讲评。 */
function GradedPanel({ exercise, result, explanation, explaining, onExplain, onRedo }: { exercise: Exercise; result: ExerciseResult; explanation: string; explaining: boolean; onExplain: () => void; onRedo: () => void }): ReactElement {
  const grade = gradeSource(result);
  const optionLabel = (id: string): string => exercise.options?.find((item) => item.id === id)?.label ?? id;
  /** 逐条判定行只有两种真数据可列：集合匹配的三类 id，与沙箱那条总体判定（沙箱不下发逐条断言名）。 */
  const rows: { passed: boolean; label: string }[] = result.gradingMode === "execution"
    ? [{ passed: result.passed, label: result.passed ? "冻结测试全部通过" : "冻结测试未全过" }]
    : result.gradingMode === "set_match"
      ? [
          ...(result.matchedIds ?? []).map((id) => ({ passed: true, label: `选中 ${optionLabel(id)}` })),
          ...(result.missingIds ?? []).map((id) => ({ passed: false, label: `漏选 ${optionLabel(id)}` })),
          ...(result.unexpectedIds ?? []).map((id) => ({ passed: false, label: `多选 ${optionLabel(id)}` }))
        ]
      : [];
  const sm2 = [`间隔 ${result.review.intervalDays} 天`, `第 ${result.review.repetitions} 次复习`, `易度系数 ${result.review.easinessFactor.toFixed(2)}`];
  if (result.review.lastReviewedAt) sm2.push(`上次作答 ${dateText(result.review.lastReviewedAt)}`);

  return (
    <div className={`feedback-panel ${result.passed ? "feedback-pass" : "feedback-fail"}`}>
      <div className="feedback-head">
        <Icon name={result.passed ? "check" : "alert"} size={16} />
        {result.passed ? "通过" : "未通过"} · {Math.round(result.score * 100)} 分
        <span className="grade-source" title={grade.detail}>判分来源：{grade.label}</span>
      </div>

      <p>{result.feedback}</p>

      {rows.length ? (
        <div className="test-table" title={result.gradingMode === "execution" ? "沙箱回的是「通过/失败」计数，逐条断言名不在界面这一层" : "逐个选项 id 与标准答案比对"}>
          {rows.map((row, index) => (
            <div className={`test-row ${row.passed ? "pass" : "fail"}`} key={`${row.label}-${index}`}>
              <span className="t-status">{row.passed ? "✓ PASS" : "✗ FAIL"}</span>
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
          <button type="button" className="btn btn-ghost btn-sm" onClick={onExplain} disabled={explaining} title="点一次才发一趟模型：讲被判那一版差在哪">
            {explaining ? <span className="spin"><Icon name="rotate" size={14} /></span> : <Icon name="zap" size={14} />}讲这版差在哪
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

/**
  左栏的已练卡片：`.d-score` 报的是掌握度档位（0–5），配色按「有没有通过记录」走。
  下次复习时间（`dueAt`）只有刚判过的那一题拿得到——排期住在 `ExerciseResult.review` 里，
  `PracticeSummary.mastery` 没有这个节点，所以其余卡片如实显示上次练习时间，不替它们编日期。
  */
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
