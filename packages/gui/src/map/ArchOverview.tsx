import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { EXTERNAL_CATEGORY_LABEL, type ArchitectureDiagramDraft, type ArchitectureLayer, type ArchitecturePlan, type CourseNode, type DiagramReadout, type CourseTree, type ExternalCategory } from "@codebase-tutor/shared";
import { api } from "../api/client";
import { EmptyState, flatten, Loading } from "../views/helpers";
import { Icon } from "../ui/icons";
import { showToast } from "../modules/toast";

/**
  架构视图 = **分层全景**（一条系统边界 + 边界内若干职责层 + 边界外的存储与外部服务）。
  它替掉了从前的「目录聚合依赖图」：那张图画的是「哪些目录互相 import」，读者看完仍不知道
  这个系统由哪几层组成。

  2026-10-16 两条定案，都在这个文件里落地：
  - **只读**：节点不能拖。改图只有 Agent 一条路（`set_architecture`），界面上不留第二个写入口——
    两边各写一套，用户的修正就可能只活在浏览器里；
  - **一个节点 = 一个节点**：引擎把原子模块压成节点（孤立节点不画、同父小目录合并），一个节点可能是几个模块。
    点组合节点展开成员，点成员才进节点详情；一层超过 6 个节点先折起，其余就地展开。
    节点下面那一行只写两种读数：这个节点的角色（引擎按 import/调用/接口实实时计算出，模型一个节点都不参与），
    或「组合节点 · N 个模块」。文件数、行数、占比那些元数据一律不上画布——要读就在对话里问 agent。
    左侧那条序号导轨也只是排版的记号：它说「第几层」，不宣称上层调用下层。

  引擎侧的 `edges` 照旧算、照旧进产物：它是「模型不许发明边」这条红线的落点（模型输出里的边一律丢弃），
  只是不再上画布（全景图里那几团线读不出东西，看往来有流程视图与节点详情）。

  两条不能混的口径：
  - 层名/归层 = 判断题（`source` 只有 `llm` 与 `unavailable` 两个节点：判过就画模型判的那份，没判过就整块说不可用，不再拿结构角色伪装成分层）；
  - 边界之外那一栏 = 词典认出来的外部包，认不出的一律「未识别」，不当服务画出来。
*/

/** 「重新生成分层」是花 token 的动作，确认框里要把量说清（一发 light 分层实测 ≈¥0.01~0.02）。 */
export const ARCH_REGEN_PRICE_NOTE = "一发轻量档调用（实测 ≈¥0.02）";
/** 花钱动作的确认文案只留一处：viewbar 那颗按钮与不可用卡片走同一段话。 */
export const ARCH_REGEN_CONFIRM = `重新生成分层会花一次模型调用（${ARCH_REGEN_PRICE_NOTE}）。变的只有层名与谁归哪层，外部依赖不变；你的人工修正会作为输入一起送进去。要继续吗？`;

/**
  分层不可用的四种原因，各自一句正文与一句该怎么办。
  正文只报「是哪一种」，完整理由在引擎那句 `reason` 里（进悬停，不占画面）。
  以前这里会画一张按结构角色分的假分层，2026-10-16 用户定：那东西没有学习价值，直接说不可用。
*/
const UNAVAILABLE: Record<string, { title: string; note: string; retryable: boolean }> = {
  not_judged: { title: "还没分层", note: "点一下判一次", retryable: true },
  no_model: { title: "没配模型", note: "先去设置里配模型", retryable: false },
  rejected: { title: "判断没采信", note: "再点一次重问", retryable: true },
  call_failed: { title: "调用没成功", note: "查一下端点再点一次", retryable: true }
};

export interface ArchStatus {
  source: ArchitecturePlan["source"] | null;
  reason: string;
  loading: boolean;
  generatedAt: string;
  layers: number;
  externals: number;
  collapsedExternals: number;
  omittedModules: number;
  /** 现在画的是默认那份，还是被对话重绘并经用户批准替换的那份。 */
  origin: "default" | "agent";
  /** 画布上正压着一张待裁决的预览：徽标得说「预览中」，不能报成现在生效的那张。 */
  previewing: boolean;
  /** 有一条重绘提议等用户点横幅（这一发还没花钱）。 */
  pending: boolean;
}

export const NO_ARCH_STATUS: ArchStatus = { source: null, reason: "", loading: false, generatedAt: "", layers: 0, externals: 0, collapsedExternals: 0, omittedModules: 0, origin: "default", previewing: false, pending: false };

type PlanView = ArchitecturePlan & { omittedModules: number; collapsedExternals: number; diagram?: DiagramReadout };

/** 重绘这一发要真读代码，确认框把量说清（与「重新生成分层」同一口径：花钱那一下由人发起）。 */
const REDRAFT_CONFIRM = "重绘这张图会让模型真去读代码，粗估 ¥0.1~0.3（比重新生成分层贵）。画好先进预览态，你不点「替换这张」就不换。要继续吗？";

/** 一层里默认露几个节点：压缩后仍超过这个数的层（本仓三层实测还有 10 个节点上下的）才折，其余一律不折。 */
const LAYER_PREVIEW = 6;
/** 节点按角色排：入口与主链路先露出来，底座和支撑排在后面（同层内部排序，不宣称谁在谁之上）。 */
const ROLE_ORDER: Record<string, number> = { entry: 0, core: 1, shared: 2, support: 3 };

/** 画布上的一个节点：引擎给的节点，可能是一个模块，也可能是几个同父小模块合起来的组合节点。 */
interface Cell {
  id: string;
  layerId: string;
  title: string;
  role: string | null;
  /** 块里的成员节点（组合节点长度 >1）：点成员才进节点详情。 */
  members: { id: string; node: CourseNode | undefined; title: string }[];
  overridden: boolean;
  /** 预览态里这个节点与引擎算出的结构角色相反：一句证据进悬停，不拦替换。 */
  conflict: string | null;
}

/** 判完一次的口径：判成说「分好层」，没判成说清是哪一种不可用（花钱动作的结果不许含糊）。 */
export function archRegenToast(plan: ArchitecturePlan): string {
  return plan.source === "llm" ? "已按模型判断分好层" : `${UNAVAILABLE[plan.unavailableReason ?? "not_judged"].title}：这次也没判成`;
}

/** 节点角色在画布上的那一行小字：只说这个节点在架构里干什么，不带文件数与占比。 */
const ROLE_LABEL: Record<string, string> = { entry: "入口", core: "核心", shared: "共享", support: "支撑" };

export function ArchOverview({ repositoryId, course, visible, selectedId, reloadNonce, regenerating, onRegenerate, onSelect, onStatus }: {
  repositoryId: string;
  course: CourseTree;
  /** 取数闸门：三视图常驻挂载，隐藏面板不该替用户点这次请求（同 FlowMap）。 */
  visible: boolean;
  selectedId?: string;
  /** 父级 bump 一下就更取一次（覆盖层落盘后、切仓后、产物刷新后）。 */
  reloadNonce: number;
  /** 「重新生成分层」的按钮长在 viewbar 上（原型口径：花钱动作与流程「重新生成」同位），调用与确认都在父级。 */
  regenerating: boolean;
  onRegenerate: () => void;
  onSelect: (node: CourseNode, scopePaths: string[]) => void;
  onStatus: (status: ArchStatus) => void;
}): ReactElement {
  const [plan, setPlan] = useState<PlanView | null>(null);
  /** 用户对预览的裁决与那一步重绘都在本组件里发生：自己 bump 一下就重取（不等父级）。 */
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let current = true;
    setLoading(true);
    setError("");
    api.getArchitecture(repositoryId)
      .then((next) => { if (current) { setPlan(next); setError(""); } })
      .catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : "架构产物取不到"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [repositoryId, visible, reloadNonce, reload]);

  const nodesById = useMemo(() => {
    const map = new Map<string, CourseNode>();
    for (const node of flatten(course.root)) if (!map.has(node.id)) map.set(node.id, node);
    return map;
  }, [course]);

  /** 模块 → 它可见的文件（锚点 + 子孙锚点，去重）：与引擎分级层、教学左栏同一条口径。 */
  const filesOf = useCallback((node: CourseNode | undefined): string[] => {
    if (!node) return [];
    const paths: string[] = [];
    const walk = (current: CourseNode): void => {
      for (const anchor of current.anchors) paths.push(anchor.path);
      current.children.forEach(walk);
    };
    walk(node);
    return [...new Set(paths)];
  }, []);

  const diagram = plan?.diagram;
  /** 预览态：候选那份摊成画布认得的层（id 用 preview-N，不与默认的 layer-N 撞名）。 */
  const previewDraft: ArchitectureDiagramDraft | undefined = diagram?.preview?.draft?.kind === "architecture" ? diagram.preview.draft : undefined;
  const shownLayers = useMemo<ArchitectureLayer[]>(() => previewDraft
    ? previewDraft.layers.map((layer, index) => ({ id: `preview-${index + 1}`, name: layer.name, duty: layer.duty, moduleIds: layer.nodes }))
    : plan?.layers ?? [], [previewDraft, plan]);
  const conflicts = useMemo(() => new Map((previewDraft?.conflicts ?? diagram?.conflicts ?? []).map((item) => [item.node, item.evidence])), [previewDraft, diagram]);
  /** 重绘那一步的状态：`run` 是唯一花钱的按钮，点了就得让画布如实显示。 */
  const [redrawing, setRedrawing] = useState(false);
  const redraw = (action: "run" | "commit" | "keep" | "reset"): void => {
    if (action === "run" && !window.confirm(REDRAFT_CONFIRM)) return;
    setRedrawing(true);
    api.redrawDiagram(repositoryId, action)
      .then((outcome) => showToast(outcome.text || (outcome.ok ? "画布已更新" : "这一步没做成")))
      .catch((reason: unknown) => showToast(reason instanceof Error ? reason.message : "重绘这一步没成功"))
      .finally(() => { setRedrawing(false); setReload((value) => value + 1); });
  };

  const cells = useMemo<Cell[]>(() => {
    if (!plan) return [];
    const briefs = new Map((plan.blocks ?? []).map((block) => [block.id, block]));
    return shownLayers.flatMap((layer) => layer.moduleIds.map((blockId) => {
      const brief = briefs.get(blockId);
      const members = (brief?.members ?? [blockId]).map((moduleId) => {
        const node = nodesById.get(moduleId);
        return { id: moduleId, node, title: node?.title ?? moduleId };
      });
      return {
        id: blockId,
        layerId: layer.id,
        // 产物比树旧时 `blocks` 里查不到这个节点：宁可不写角色，也不替它编一个「支撑」伪装成读数
        role: brief?.role ?? null,
        // 组合节点的标题在产物里（像「枚举、文档」）；块被人工拆开或产物比树旧时退回成员名／原 id，不编一个看不出的名字
        title: brief?.title ?? members[0]?.title ?? blockId,
        members,
        overridden: !previewDraft && plan.overriddenUnits.includes(blockId),
        conflict: conflicts.get(blockId) ?? null
      };
    }));
  }, [plan, nodesById, shownLayers, conflicts, previewDraft]);

  /** 折起来的两处开关：整层剩下的节点、组合节点的成员。都只活在这次读图里，不落盘也不进请求。 */
  const [openLayers, setOpenLayers] = useState<string[]>([]);
  const [openCells, setOpenCells] = useState<string[]>([]);
  useEffect(() => { setOpenLayers([]); setOpenCells([]); }, [plan]);

  const externalsByCategory = useMemo(() => {
    const grouped = new Map<ExternalCategory, PlanView["externals"]>();
    for (const row of plan?.externals ?? []) grouped.set(row.category, [...(grouped.get(row.category) ?? []), row]);
    return grouped;
  }, [plan]);

  const emitStatus = onStatus;
  useEffect(() => {
    emitStatus(plan
      ? { source: plan.source, reason: plan.reason ?? "", loading: loading || regenerating || redrawing, generatedAt: plan.generatedAt, layers: shownLayers.length, externals: plan.externals.length, collapsedExternals: plan.collapsedExternals, omittedModules: plan.omittedModules, origin: diagram?.origin ?? "default", previewing: Boolean(previewDraft), pending: Boolean(diagram?.pending) }
      : { ...NO_ARCH_STATUS, loading: loading || regenerating });
  }, [plan, loading, regenerating, redrawing, shownLayers, previewDraft, diagram, emitStatus]);


  const toggle = (list: string[], setList: (next: string[]) => void, key: string): void => setList(list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);

  /** 原子块点一下就走节点详情；组合节点先展开，成员那一层才绑作用域（`arch:` 的 id 课程树里查无此人）。 */
  const pick = (member: { node: CourseNode | undefined; title: string } | undefined): void => {
    if (!member?.node) {
      showToast(`产物比树旧：${member?.title ?? "这个节点"}已不在当前课程树里`);
      return;
    }
    onSelect(member.node, filesOf(member.node));
  };

  if (!visible) return <div className="empty" aria-hidden />;
  if (error && !plan) return <EmptyState title="架构视图暂时不可用" detail={error} />;
  if (!plan) return <Loading />;

  // 只有「默认没判过」**且**没有被批准的重绘图时才走不可用卡片：用户点过头的那张是生效产物，不是兜底
  if (plan.source === "unavailable" && plan.diagram?.origin !== "agent") {
    const state = UNAVAILABLE[plan.unavailableReason ?? "not_judged"];
    return (
      <div className="arch-pan">
        <div className="arch-unavailable">
          <Icon name="alert" size={18} />
          <div>
            <p className="arch-unavailable-title">{state.title}</p>
            <p className="arch-unavailable-note" title={`${plan.reason ?? ""}· 节点清单与边界之外那一栏都由程序算出，仍在这份产物里，问 agent 就有；它们要对着系统边界才读得出意思，所以这里不单独摊开。`}>{state.note}</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={loading || regenerating || !state.retryable} title={state.retryable ? `${ARCH_REGEN_PRICE_NOTE}。分层是判断题：不判就没有层可画。` : "这条路由不降级：没配模型时点它只会白跑一次"} onClick={onRegenerate}><Icon name="rotate" size={13} />重新生成分层</button>
        </div>
      </div>
    );
  }


  return (
    <div className="arch-pan">
      {plan.lostOverrides?.length ? (
        <div className="banner banner-warn">
          <Icon name="alert" size={14} />
          <div className="banner-text" title={plan.lostOverrides.map((loss) => loss.kind === "move_module"
            ? `把 ${loss.module} 挪进「${loss.layer}」没生效：现在这份判层里没有这一层，或那个 id 已经不在树上`
            : `层名「${loss.from}」的改动没生效：现在没有这个旧层名`).join("\n")}>
            <strong>{`${plan.lostOverrides.length} 处人工修正这次没生效`}</strong>
            <span> · 跟现在这份判层对不上，要清掉就在对话里说一声</span>
          </div>
        </div>
      ) : null}
      {plan.omittedModules ? (
        <div className="banner banner-info">
          <Icon name="info" size={14} />
          <div className="banner-text" title="节点数超过上限的仓只送前 80 个节点进分层，剩下这些没参与判断">{`只分层前 80 个节点，另 ${plan.omittedModules} 个节点没进来`}</div>
        </div>
      ) : null}
      {diagram?.stale ? (
        <div className="banner banner-warn">
          <Icon name="alert" size={14} />
          <div className="banner-text" title={`${diagram.stale}。那张替换图还在，等树上的模块接回来会自己出现；现在画的是默认那份。`}>
            <strong>替换图对不上现在的树</strong>
            <span> · 画的是默认</span>
          </div>
        </div>
      ) : null}
      {diagram?.pending ? (
        <div className="banner banner-warn">
          <Icon name="alert" size={14} />
          <div className="banner-text" title={`目的：${diagram.pending.purpose}。这一发要让模型真去读代码再重排节点，粗估 ¥0.1~0.3；点「开始重绘」才发请求——agent 自己按不了这个按钮。`}>
            <strong>agent 提议重绘这张</strong>
            <span> · 约 ¥0.1~0.3</span>
          </div>
          <div className="banner-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={redrawing} onClick={() => redraw("run")}><Icon name="rotate" size={13} />开始重绘</button>
            <button type="button" className="btn btn-sm ghost" disabled={redrawing} onClick={() => redraw("keep")}>算了</button>
          </div>
        </div>
      ) : null}
      {previewDraft ? (
        <div className="banner banner-info">
          <Icon name="info" size={14} />
          <div className="banner-text" title={`目的：${diagram?.preview?.purpose ?? ""}。${previewDraft.layers.length} 层、${previewDraft.layers.reduce((total, layer) => total + layer.nodes.length, 0)} 个节点，另有 ${previewDraft.omitted.length} 个节点列了理由没画。箭头与「边界之外」仍是程序按 import 算的，这张图里一条都不来自模型。${previewDraft.conflicts.length ? `其中 ${previewDraft.conflicts.length} 个节点与引擎算出的结构角色相反，节点上标了点。` : ""}`}>
            <strong>这是一张预览</strong>
            <span> · 还没替换</span>
          </div>
          <div className="banner-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={redrawing} onClick={() => redraw("commit")}>替换这张</button>
            <button type="button" className="btn btn-sm ghost" disabled={redrawing} onClick={() => redraw("keep")}>保持现在的</button>
          </div>
        </div>
      ) : null}
      {!previewDraft && !diagram?.pending && diagram?.origin === "agent" ? (
        <div className="banner banner-info">
          <Icon name="info" size={14} />
          <div className="banner-text" title={`这张是按对话重绘、并经你批准替换的（目的：${diagram.purpose ?? "未记录"}）。默认那份没删，一句话就能回去。`}>
            <strong>这张是按对话重绘的</strong>
            <span> · 可回默认</span>
          </div>
          <div className="banner-actions">
            <button type="button" className="btn btn-sm ghost" disabled={redrawing} onClick={() => redraw("reset")}>恢复默认图</button>
          </div>
        </div>
      ) : null}
      <div className={`arch-boundary${previewDraft ? " previewing" : ""}`}>
        <span className="arch-boundary-label">{previewDraft ? "预览中的这张图 · 还没替换" : "系统边界 · 框内是自己写的代码"}</span>
        {shownLayers.map((layer, index) => {
          const layerCells = cells.filter((cell) => cell.layerId === layer.id)
            .sort((left, right) => (ROLE_ORDER[left.role ?? "support"] - ROLE_ORDER[right.role ?? "support"]) || left.title.localeCompare(right.title));
          const opened = openLayers.includes(layer.id);
          const shown = opened ? layerCells : layerCells.slice(0, LAYER_PREVIEW);
          const folded = layerCells.length - shown.length;
          return (
            <div key={layer.id} className="arch-layer">
              <div className="arch-rail">
                <span className="arch-rail-no">{index + 1}</span>
                {index < shownLayers.length - 1 ? <span className="arch-rail-line" /> : null}
              </div>
              <div className="arch-layer-body">
                <div className="arch-layer-head">
                  <span className="arch-layer-name" title={layer.duty}>
                    {layer.name}
                    {layer.overridden ? <span className="arch-override-dot" title="这层的名字是人工改过的，不是模型起的" /> : null}
                  </span>
                  <span className="arch-layer-duty">{layer.duty}</span>
                </div>
                <div className="arch-layer-blocks">
                  {shown.map((cell) => {
                    const grouped = cell.members.length > 1;
                    // 选中的模块正好在被合起来的那个节点里时自动展开：从左栏点到哪儿，图上就得看得见那个节点
                    const openedCell = openCells.includes(cell.id) || (grouped && cell.members.some((member) => member.node?.id === selectedId));
                    const note = [grouped ? "这个节点合起了几个小模块，点开看成员" : "", cell.overridden ? "这个节点的归属是人工改过的，不是模型判的" : "", cell.conflict ? `与结构证据相反：${cell.conflict}` : ""].filter(Boolean).join("；");
                    return (
                      <div key={cell.id} className="arch-cell">
                        <button
                          type="button"
                          className={`arch-module${grouped ? " grouped" : ""}${cell.role === "entry" ? " entry" : ""}${cell.overridden ? " moved" : ""}${cell.conflict ? " conflict" : ""}${!grouped && selectedId === cell.id ? " selected" : ""}`}
                          title={note || undefined}
                          onClick={() => (grouped ? toggle(openCells, setOpenCells, cell.id) : pick(cell.members[0]))}
                        >
                          <span className="arch-module-name">{cell.title}</span>
                          {/* 副行只说这个节点在架构里干什么：组合节点报成员数，产物没记角色的那个节点就留空，不补一个假的的「支撑」 */}
                          {grouped ? <span className="arch-module-sub">{`组合节点 · ${cell.members.length} 个模块`}</span> : cell.role ? <span className="arch-module-sub">{ROLE_LABEL[cell.role]}</span> : null}
                        </button>
                        {openedCell ? (
                          <div className="arch-members">
                            {cell.members.map((member) => (
                              <button
                                key={member.id}
                                type="button"
                                className={`arch-member${member.node?.id === selectedId ? " selected" : ""}`}
                                onClick={() => pick(member)}
                              >{member.title}</button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {folded > 0 || opened ? (
                    <button
                      type="button"
                      className="arch-more"
                      title={`这一层共 ${layerCells.length} 个节点，默认显示 ${LAYER_PREVIEW} 个；折起来的没删，点开还在`}
                      onClick={() => toggle(openLayers, setOpenLayers, layer.id)}
                    >{opened ? "收起" : `另有 ${folded} 个节点`}</button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="arch-outside-box">
        <span className="arch-boundary-label">边界之外 · 只用不实现</span>
        {plan.externals.length ? (
          <div className="arch-outside-groups">
            {[...externalsByCategory.entries()].map(([category, rows]) => (
              <div className="arch-outside-group" key={category}>
                <span className="arch-outside-cat">{EXTERNAL_CATEGORY_LABEL[category]}</span>
                <div className="arch-outside-rows">
                  {rows.map((row) => (
                    <span className="arch-external" key={row.display} title={`${row.identities.join("、")}${row.usedBy ? ` · ${row.usedBy} 个文件用到` : ""}`}>
                      {row.display}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="arch-outside-empty">{plan.externalsNote ?? "这份产物里边界外是空的：静态图没采到外部包名，也不等于这个系统不碰外部服务。"}</p>
        )}
        {plan.collapsedExternals ? <p className="arch-outside-empty" title="同一类别里认出来的包按显示名合过，合了几组记在这里">{`另有 ${plan.collapsedExternals} 组同类的已经合进上面那些条`}</p> : null}
      </div>
      <p className="arch-legend">分层判错了？在右侧对话里让 agent 挪（set_architecture）· 节点只读，没有第二个写入口</p>
    </div>
  );
}
