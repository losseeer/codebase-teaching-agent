import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { FlowStage, FlowStageKind, RepositoryAnalysis, RepositoryFlow, RepositoryIndex, SourceAnchor } from "@codebase-tutor/shared";
import { api } from "../api/client";
import { useEverVisible } from "../ui/useEverVisible";
import { OptionDropdown, type DropdownOption } from "../ui/OptionDropdown";
import { Icon } from "../ui/icons";

/**
 * 宏观设计 v0.10：流程视图（与 `DepMap` 的架构视图并列，prototype `.flow-col` + `.flow-stage`）。

 * 两个视图的分工：
 * - 架构视图由**文件**驱动：节点 = 目录聚合模块，边 = import 依赖。客观、稳定、可穷举。
 * - 流程视图由**LLM 生成**：环节是一次执行经过的步骤，每个环节的关联文件**只出现在节点详情里**。
 *
 * 为什么流程不画静态调用链：`add_node("evaluate", evaluate)`、路由表、插件与依赖注入这类**编排**
 * 不产生调用边，静态链在真正的主干处是断的。模型能从文件与符号语义里读出编排，这正是本视图的增量。
 * 静态调用链仍在，它作为模型输入，并在 LLM 不可用时充当降级视图——降级会显式标注，不冒充模型结论。
 *
 * 环节数、关联文件数都由 engine 侧校验（路径必须真实存在，行号必须落在文件范围内），
 * 前端不再二次猜测；`caveats` 原样展示，包含被丢弃的环节与文件。
 * `flow.edges[]` 的 `origin`（static / code / inferred）是「这条边有多可核对」的分界，
 * 画布上给三档图例，具体依据进环节详情的抽屉。
 */

/** 环节性质的中文展示；详情抽屉与画布共用同一份，避免一处一个叫法。 */
export const FLOW_KIND_LABEL: Record<FlowStageKind, string> = {
  entry: "入口",
  stage: "环节",
  decision: "判断",
  loop: "回环",
  exit: "出口"
};

/** 生成中覆盖层上的步骤说明（引擎侧真实工序，见 engine `flows/flow.ts`）。 */
const GEN_PHASES = ["装配 digest：目录骨架 + 符号 + 跨文件调用链", "LLM 生成环节与边", "parseFlow 硬校验 + 边级只降不升 + 按需深读"];

/** 正则匹配一次最多铺开这么多条：再多也读不过来，靠改正则收窄而不是滚动。 */
const MATCH_LIMIT = 60;

/** 路径末两段做主文案：整路径前缀几乎都一样（src/main/java/com/hmdp/…），能区分的是尾巴。 */
function pathTail(path: string): string {
  const segments = path.split("/");
  return segments.length > 1 ? segments.slice(-2).join("/") : path;
}

/**
  engine 的入口标签是英文短语（`detectEntrypoints`），界面上按项目惯例转中文；
  没收录的标签原样显示，不编造译名。
  */
function entryLabel(label: string): string {
  if (label === "conventional entrypoint") return "约定入口文件";
  if (label === "package main") return "package.json main";
  if (label === "CLI command") return "CLI 命令";
  const script = label.match(/^script:\s*(.+)$/);
  return script ? `启动脚本 ${script[1]}` : label;
}

interface FlowState {
  flow: RepositoryFlow;
  source: "llm" | "static";
  reason?: string;
}

/**
  默认入口：优先选有仓内 import/调用边的入口（与 engine 侧 `resolveFlowEntry` 同一口径，改一边要同步另一边）。
  Spring 启动类这类文件看着是入口，import 却全指向框架，静态证据凑不出一条流程、首屏必然降级；
  全体入口都没有边时才回落第一个。
  */
function preferredEntryPath(entries: SourceAnchor[], analysis: RepositoryAnalysis): string {
  if (!entries.length) return "";
  const linked = new Set<string>();
  for (const [from, targets] of Object.entries(analysis.graph.imports)) {
    // 与 engine `resolveFlowEntry` 同口径：空数组键只是「被分析过」的登记，不是边证据（真仓 172 键里 89 个为空）
    if (targets.length) linked.add(from);
    for (const target of targets) linked.add(target);
  }
  for (const call of analysis.graph.calls) {
    linked.add(call.callerPath);
    linked.add(call.calleePath);
  }
  return entries.find((entry) => linked.has(entry.path))?.path ?? entries[0].path;
}

/** 选中的环节 + 它所属的流程（详情抽屉需要两者：环节给文件，流程给标题与边界）；null 表示未选。 */
export interface FlowSelection {
  stage: FlowStage;
  flow: RepositoryFlow;
}

/**
  回告给页面的读数：来源徽标、生成时间与「重新生成」都长在 `.map-viewbar` 上，
  而这一趟取数只住在这里（流程生成是最贵的一次 LLM 调用），所以状态往外报一次，不做第二份真源。
  */
export interface FlowStatus {
  /** null = 这一趟还没有结果（未生成 / 在途 / 失败） */
  source: "llm" | "static" | null;
  generatedAt: string;
  title: string;
  summary: string;
  loading: boolean;
}

export function FlowMap({ repositoryId, analysis, index, visible, selectedStageOrder, regenNonce, onStatus, onSelectStage }: {
  repositoryId: string;
  analysis: RepositoryAnalysis;
  /** 全部已索引文件：入口识别是启发式，识别不到/识别错时由用户从这里手动指定流程起点 */
  index: RepositoryIndex;
  /** 宏观设计是不是当前 tab。流程生成是这条路径上最贵的一次 LLM 调用，而三视图常驻挂载 ⇒
      停在别的 tab 时不该由隐藏的宏观设计面板替用户点它。 */
  visible: boolean;
  selectedStageOrder?: number;
  /** 页面顶栏的「重新生成」：这个数一变就换 key 重取（与内部重试共用同一个键） */
  regenNonce: number;
  onStatus: (status: FlowStatus) => void;
  onSelectStage: (selection: FlowSelection | null) => void;
}): ReactElement {
  const entries = analysis.graph.entrypoints;
  /** 闸门是单向的：没打开过宏观设计就一次都不生成流程；打开过之后照旧按输入变化重取，
      来回切 tab 不重发（`visible` 直接进依赖会让每次切回来都清空结果、重跑一次并闪骨架）。 */
  const everVisible = useEverVisible(visible);
  const [entryPath, setEntryPath] = useState(() => preferredEntryPath(entries, analysis));
  const [state, setState] = useState<FlowState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fileOptions = useMemo(
    () => index.files.map((file) => file.path).sort((left, right) => left.localeCompare(right)),
    [index]
  );
  const entryIsKnown = entries.some((entry) => entry.path === entryPath) || fileOptions.includes(entryPath);
  useEffect(() => {
    if (!entryIsKnown) setEntryPath(preferredEntryPath(entries, analysis));
  }, [entries, entryIsKnown, analysis]);

  /** 核心入口按 path 去重：同一个类可能被认成两种入口（约定名 + 启动脚本），并列两条只会让人以为能选两件东西。 */
  const coreOptions = useMemo<DropdownOption[]>(() => {
    const byPath = new Map<string, string[]>();
    for (const item of entries) byPath.set(item.path, [...(byPath.get(item.path) ?? []), entryLabel(item.label)]);
    return [...byPath].map(([path, labels]) => ({ value: path, label: labels.join(" · "), detail: path, note: `${labels.join(" / ")}\n${path}` }));
  }, [entries]);

  /** 自定义入口＝路径正则：156~上千个文件不可能靠一个 select 翻找，正则既能「找某个类」也能「看全部」。 */
  const [pattern, setPattern] = useState("");
  const [coreOpen, setCoreOpen] = useState(false);
  const matches = useMemo<{ paths: string[]; total: number; error: string }>(() => {
    const needle = pattern.trim();
    if (!needle) return { paths: [], total: fileOptions.length, error: "" };
    try {
      const re = new RegExp(needle, "i");
      const paths = fileOptions.filter((path) => re.test(path));
      return { paths, total: paths.length, error: "" };
    } catch (error) {
      return { paths: [], total: 0, error: error instanceof Error ? error.message : "正则不合法" };
    }
  }, [pattern, fileOptions]);
  const shownMatches = matches.paths.slice(0, MATCH_LIMIT);
  /** 换起点：收起下拉、清掉环节选中（旧流程的环节号对新流程没有意义）。 */
  const choose = (path: string): void => {
    setEntryPath(path);
    setCoreOpen(false);
    onSelectStage(null);
  };

  /** 重试计数：值一变就重跑取数 effect——失败前这里只有一条虚线文案，用户只能切视图重挂载。 */
  const [attempt, setAttempt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  /** 一次取流程的唯一键。StrictMode 会把 effect 跑两遍（mount → cleanup → mount），而流程生成**冷缓存时是真金白银**：
      两个并发请求都判未命中，同一份输入烧两次（今天实测两条各 9,621 in）。所以按 key 去重——
      同一个 key 只发一次；换入口 / 重分析 / 点重试都会换 key，照常再发。 */
  const flowKey = `${repositoryId}:${entryPath}:${analysis.versionStamp}:${attempt}:${regenNonce}`;
  const requestedFlow = useRef("");
  useEffect(() => {
    if (!entryPath || !everVisible || requestedFlow.current === flowKey) return;
    requestedFlow.current = flowKey;
    setLoading(true);
    setError("");
    setState(null);
    // 过期响应按 key 判死，**不用**卸载标志：StrictMode 的 cleanup 会把第一次的好结果丢掉，
    // 第二次 mount 又被 key 去重挡住不再发 —— 界面就永久停在 loading（教学面板踩过同一个坑）。
    api.getRepositoryFlow(repositoryId, entryPath)
      .then((result) => { if (requestedFlow.current === flowKey) setState(result); })
      .catch((reason: unknown) => { if (requestedFlow.current === flowKey) setError(reason instanceof Error ? reason.message : "无法生成流程"); })
      .finally(() => { if (requestedFlow.current === flowKey) setLoading(false); });
    // analysis.versionStamp 变化（仓库重分析）后流程需要重新生成
  }, [repositoryId, entryPath, analysis.versionStamp, attempt, regenNonce, everVisible, flowKey]);

  // 首次生成是几十秒量级的 LLM 调用，只有一行文案看不出「还在动」——计时 + 骨架给出进度感
  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => { clearInterval(timer); };
  }, [loading]);

  // 顶栏徽标要跟着这趟取数走：只保留最新闭包，effect 依赖仍按取数状态来（否则每次渲染都回告一遍）
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  useEffect(() => {
    onStatusRef.current({
      source: state ? state.source : null,
      generatedAt: state?.flow.generatedAt ?? "",
      title: state?.flow.title ?? "",
      summary: state?.flow.summary ?? "",
      loading
    });
  }, [state, loading]);

  const entryAnchor = entries.find((entry) => entry.path === entryPath);
  const isCustomEntry = !!entryPath && !entries.some((entry) => entry.path === entryPath);

  return (
    <>
      {loading ? (
        <div className="gen-overlay">
          <div className="card card-pad col" style={{ width: 340, maxWidth: "80%" }}>
            <div className="section-title">正在生成流程视图</div>
            {/* 这三行是引擎侧的工序说明，不是进度条：接口不给逐相进度，所以只有文字与计时 */}
            {GEN_PHASES.map((phase) => (
              <div className="phase" key={phase}>
                <span className="phase-dot" aria-hidden />
                <span className="fs-12">{phase}</span>
              </div>
            ))}
            <div className="row between">
              <span className="fs-12" title="首次由 LLM 生成，可能要几十秒；同一版本的第二次访问直接命中缓存">首次生成可能要几十秒</span>
              <span className="mono fs-12">{`已等待 ${elapsed}s`}</span>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flow-col">
        {!entries.length ? (
          <div className="empty">
            <span className="empty-icon"><Icon name="info" size={18} /></span>
            <p>该仓库没有识别到执行入口</p>
            <span className="fs-11" title="入口由 package.json 的 main/bin/scripts 与 main/server/app/index 等约定文件名推断，裸脚本或非常规布局的仓会识别不到">
              入口按约定文件名与 package.json 推断
            </span>
            <span className="fs-11">在下方输入路径正则，挑一个已索引文件当流程起点</span>
          </div>
        ) : null}

        <div className="flow-entry-bar" role="group" aria-label="选择执行入口">
          <OptionDropdown
            label="核心流程入口"
            tone="core"
            placeholder={coreOptions.length ? `${coreOptions.length} 个识别到的入口` : "未识别到入口"}
            ariaLabel="选择核心流程入口"
            options={coreOptions}
            value={entryPath}
            open={coreOpen}
            onOpenChange={setCoreOpen}
            onSelect={choose}
          />
          {entryPath ? (
            <span className="badge badge-neutral mono" title={`起点 ${entryPath}${entryAnchor ? `:${entryAnchor.line}` : ""}`}>
              {`${pathTail(entryPath)}${entryAnchor ? `:${entryAnchor.line}` : ""}`}
            </span>
          ) : null}
          <input
            className="text-input"
            value={pattern}
            placeholder={`自定义入口：路径正则，如 controller|Application（. 看全部 ${fileOptions.length} 个）`}
            title="按路径正则匹配已索引文件，点匹配结果即把它设为流程起点（引擎识别不到入口时的兜底，也用来试非常规起点）"
            aria-label="自定义流程入口：按路径正则匹配已索引文件"
            spellCheck={false}
            onChange={(event) => setPattern(event.target.value)}
          />
          <span className="fs-11 faint">
            {matches.error ? "正则不合法" : pattern.trim() ? `匹配 ${matches.total} 个` : `${fileOptions.length} 个已索引文件`}
          </span>
          {shownMatches.length ? (
            <div className="picker-matches" role="listbox" aria-label="正则匹配到的文件">
              {shownMatches.map((path) => (
                <button
                  type="button"
                  key={path}
                  role="option"
                  aria-selected={path === entryPath}
                  className={`picker-option ${path === entryPath ? "active" : ""}`}
                  title={path}
                  onClick={() => choose(path)}
                >
                  <span>{pathTail(path)}</span>
                  {path === entryPath ? <b>当前</b> : null}
                </button>
              ))}
              {matches.total > shownMatches.length ? (
                <span className="picker-empty">{`只列前 ${MATCH_LIMIT} 条（共 ${matches.total} 条）· 正则收紧些`}</span>
              ) : null}
            </div>
          ) : null}
          {isCustomEntry ? (
            <span className="row fs-11 faint">
              <code title={entryPath}>{pathTail(entryPath)}</code>
              <span>当前起点（自定义）</span>
              {coreOptions.length ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => choose(preferredEntryPath(entries, analysis))}>回到核心入口</button> : null}
            </span>
          ) : null}
          {pattern.trim() && !matches.error && !matches.total ? (
            <span className="fs-11 faint">没有文件匹配：换个短点的词，或输入 <code>.</code> 看全部。</span>
          ) : null}
          {matches.error ? <span className="field-note warn">正则不合法：{matches.error}</span> : null}
        </div>

        {loading ? (
          <div className="flow-skeleton" aria-hidden>
            {[62, 78, 54, 70].map((w, i) => <span key={i} style={{ width: `${w}%` }} />)}
          </div>
        ) : null}

        {error ? (
          <div className="banner banner-danger" role="alert">
            <Icon name="alert" size={14} />
            <div className="banner-text">{error}</div>
            <div className="banner-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAttempt((a) => a + 1)}><Icon name="rotate" size={12} />重试</button>
            </div>
          </div>
        ) : null}

        {state ? (
          <>
            {state.source === "static" ? (
              <div className="banner banner-warn">
                <Icon name="alert" size={14} />
                <div className="banner-text">
                  <strong>以下不是模型生成，而是静态调用链降级视图。</strong>
                  {state.reason ? `原因：${state.reason}。` : ""}
                  它只反映代码里的跨文件调用，看不到回调注册、路由表与依赖注入等编排，环节可能比真实执行路径少。
                </div>
              </div>
            ) : null}

            {state.flow.stages.map((stage, position) => (
              <Fragment key={stage.order}>
                {position > 0 ? <div className="flow-arrow"><Icon name="arrowDown" size={15} /></div> : null}
                <button
                  type="button"
                  className={`flow-stage col${stage.kind === "decision" ? " decision" : ""}${selectedStageOrder === stage.order ? " selected" : ""}`}
                  title={`${stage.title}：${stage.detail}`} // 卡片上的 detail 被 CSS clamp，悬停给全文
                  onClick={() => onSelectStage(selectedStageOrder === stage.order ? null : { stage, flow: state.flow })}
                >
                  <span className="fs-head">
                    <span className="fs-order">{String(stage.order).padStart(2, "0")}</span>
                    <span className="fs-title">{stage.title}</span>
                    <span className="fs-kind">{`${FLOW_KIND_LABEL[stage.kind]} · ${stage.files.length} 文件`}</span>
                  </span>
                  <span className="fs-detail">{stage.detail}</span>
                  {stage.branches.length ? (
                    <span className="fs-branches">
                      {stage.branches.map((branch) => <span key={branch} className="branch-chip">{branch}</span>)}
                    </span>
                  ) : null}
                  {stage.loopsTo !== undefined ? <span className="flow-loop-note">{`回环指向第 ${stage.loopsTo} 环节`}</span> : null}
                </button>
              </Fragment>
            ))}
            <div className="flow-arrow" style={{ height: 8 }} aria-hidden />

            {/* 边的可核对强度分三档，读法各不相同：绿=依赖图能证明，蓝=正文里读到，黄=模型推断 */}
            <div className="flow-legend">
              <span className="flow-origin origin-static">static · 依赖图可证明</span>
              <span className="flow-origin origin-code">code · 源码正文读过</span>
              <span className="flow-origin origin-inferred">inferred · 模型推断</span>
              <span className="fs-11 faint" title="点任一环节，抽屉里列它的出边与这条边的依据">点环节看它的出边依据</span>
            </div>

            <p className="field-note">
              {`共 ${state.flow.stages.length} 个环节。每个环节的关联文件在右侧「节点详情」里，点环节打开。`}
              {state.flow.caveats ? `已知边界：${state.flow.caveats}` : ""}
            </p>
            {state.flow.uncovered?.length ? (
              <div className="flow-legend">
                <span className="fs-11 faint">没能确认的部分</span>
                {state.flow.uncovered.map((item) => <span className="badge badge-warn" key={item} title={item}>{item}</span>)}
              </div>
            ) : null}
          </>
        ) : null}

        {/* 起点都在、却没出结果（不在宏观设计待过 / 引擎暂时没回）才补这一块；没有入口时上面那块空状态已经说清了 */}
        {entryPath && !state && !loading && !error ? (
          <div className="empty">
            <span className="empty-icon"><Icon name="info" size={18} /></span>
            <p>还没有流程结果</p>
            <span className="fs-11" title="流程由 LLM 依据静态证据（依赖关系、符号、静态调用链）生成；选好起点后自动开始，失败可重试">
              点「重新生成」或换一个起点
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
}
