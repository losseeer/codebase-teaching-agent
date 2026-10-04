import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Sparkles } from "lucide-react";
import type { FlowStage, FlowStageKind, RepositoryAnalysis, RepositoryFlow, RepositoryIndex, SourceAnchor } from "@codebase-tutor/shared";
import { api } from "../api/client";
import { useEverVisible } from "../ui/useEverVisible";
import { OptionDropdown, type DropdownOption } from "../ui/OptionDropdown";

/**
 * 宏观设计 v0.10：流程视图（与 `DepMap` 的架构视图并列）。

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
 */

/** 环节性质的中文展示；详情抽屉与画布共用同一份，避免一处一个叫法。 */
export const FLOW_KIND_LABEL: Record<FlowStageKind, string> = {
  entry: "入口",
  stage: "环节",
  decision: "判断",
  loop: "回环",
  exit: "出口"
};

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

export function FlowMap({ repositoryId, analysis, index, visible, selectedStageOrder, onSelectStage }: {
  repositoryId: string;
  analysis: RepositoryAnalysis;
  /** 全部已索引文件：入口识别是启发式，识别不到/识别错时由用户从这里手动指定流程起点 */
  index: RepositoryIndex;
  /** 宏观设计是不是当前 tab。流程生成是这条路径上最贵的一次 LLM 调用，而三视图常驻挂载 ⇒
      停在别的 tab 时不该由隐藏的宏观设计面板替用户点它。 */
  visible: boolean;
  selectedStageOrder?: number;
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
  }, [entries, entryIsKnown]);

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
  const flowKey = `${repositoryId}:${entryPath}:${analysis.versionStamp}:${attempt}`;
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
  }, [repositoryId, entryPath, analysis.versionStamp, attempt, everVisible, flowKey]);

  // 首次生成是几十秒量级的 LLM 调用，只有一行文案看不出「还在动」——计时 + 骨架给出进度感
  useEffect(() => {
    if (!loading) { setElapsed(0); return; }
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => { clearInterval(timer); };
  }, [loading]);

  return (
    <div className="map-scroll">
      <div className="map-inner flow-inner">
        {!entries.length ? (
          <p className="flow-empty">
            该仓库没有识别到执行入口——入口由 package.json 的 main/bin/scripts 与 main/server/app/index
            等约定文件名推断，裸脚本或非常规布局的仓会识别不到。在下方「自定义流程入口」输入路径正则，挑一个已索引文件作为流程起点即可。
          </p>
        ) : null}
        <div className="flow-entries" role="group" aria-label="选择执行入口">
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
          <div className="flow-entry-custom">
            <label className="flow-entry-pattern">
              <span>自定义流程入口</span>
              <input
                value={pattern}
                placeholder={`路径正则，如 controller|Application；输入 . 匹配全部 ${fileOptions.length} 个文件`}
                title="按路径正则匹配已索引文件，点匹配结果即把它设为流程起点（引擎识别不到入口时的兜底，也用来试非常规起点）"
                spellCheck={false}
                onChange={(event) => setPattern(event.target.value)}
              />
              <em>{matches.error ? "正则不合法" : pattern.trim() ? `匹配 ${matches.total} 个` : `${fileOptions.length} 个已索引文件`}</em>
            </label>
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
                  <span className="picker-empty">{`只列前 ${MATCH_LIMIT} 条（共 ${matches.total} 条匹配）——把正则收紧些`}</span>
                ) : null}
              </div>
            ) : null}
            {pattern.trim() && !matches.error && !matches.total ? (
              <p className="flow-entry-hint">没有文件的 path 匹配这条正则：先试更短的词，或输入 <code>.</code> 看全部清单。</p>
            ) : null}
            {matches.error ? <p className="flow-entry-hint">正则不合法：{matches.error}</p> : null}
          </div>
          {entryPath && !entries.some((item) => item.path === entryPath) ? (
            <p className="flow-entry-current">
              当前起点（自定义）：<code>{entryPath}</code>
              {coreOptions.length ? <button type="button" onClick={() => choose(preferredEntryPath(entries, analysis))}>回到核心入口</button> : null}
            </p>
          ) : null}
        </div>

        {loading ? (
          <div className="flow-loading">
            <p className="flow-status"><Sparkles size={13} />{`正在生成流程…已等待 ${elapsed}s（首次由 LLM 生成，可能要几十秒；之后同一版本直接命中缓存）`}</p>
            <div className="flow-skeleton" aria-hidden>
              {[62, 78, 54, 70].map((w, i) => <span key={i} style={{ width: `${w}%` }} />)}
            </div>
          </div>
        ) : null}
        {error ? (
          <p className="flow-status error">
            {error}
            <button type="button" className="flow-retry" onClick={() => setAttempt((a) => a + 1)}>重试</button>
          </p>
        ) : null}

        {state ? (
          <>
            <div className="flow-head">
              <h3>{state.flow.title}</h3>
              <p>{state.flow.summary}</p>
            </div>
            {state.source === "static" ? (
              <p className="flow-degraded">
                <strong>以下不是模型生成，而是静态调用链降级视图。</strong>
                {state.reason ? `原因：${state.reason}。` : ""}
                它只反映代码里的跨文件调用，看不到回调注册、路由表与依赖注入等编排，环节可能比真实执行路径少。
              </p>
            ) : null}

            <ol className="flow-chain">
              {state.flow.stages.map((stage) => {
                const classes = [
                  "flow-step",
                  stage.kind === "entry" ? "entry" : "",
                  selectedStageOrder === stage.order ? "selected" : ""
                ].filter(Boolean).join(" ");
                return (
                  <li key={stage.order}>
                    <button
                      type="button"
                      className={classes}
                      title={`${stage.title}：${stage.detail}`} // 卡片上的 detail 被 CSS clamp，悬停给全文
                      onClick={() => onSelectStage(selectedStageOrder === stage.order ? null : { stage, flow: state.flow })}
                    >
                      <span className="flow-step-order">{String(stage.order).padStart(2, "0")}</span>
                      <span className="flow-step-main">
                        <span className="flow-step-kind">{FLOW_KIND_LABEL[stage.kind]}</span>
                        <strong>{stage.title}</strong>
                        <small className="flow-step-detail">{stage.detail}</small>
                        <span className="flow-step-flags">
                          {stage.loopsTo !== undefined ? <em className="flag-loop">{`↺ 回到 #${stage.loopsTo}`}</em> : null}
                          {stage.files.length ? <em className="flag-files">{`关联 ${stage.files.length} 个文件`}</em> : null}
                        </span>
                        {stage.branches.length ? (
                          <span className="flow-step-branches">
                            {stage.branches.map((branch) => <em key={branch}>{branch}</em>)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <p className="flow-footnote">
              {`共 ${state.flow.stages.length} 个环节。每个环节的关联文件在右侧「节点详情」里，点环节打开。`}
              {state.flow.caveats ? `已知边界：${state.flow.caveats}` : ""}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}
