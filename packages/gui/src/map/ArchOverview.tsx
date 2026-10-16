import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { EXTERNAL_CATEGORY_LABEL, type ArchitecturePlan, type CourseNode, type CourseTree, type ExternalCategory, type RepositoryAnalysis } from "@codebase-tutor/shared";
import { api } from "../api/client";
import { EmptyState, flatten, Loading } from "../views/helpers";
import { Icon } from "../ui/icons";
import { showToast } from "../modules/toast";

/**
  架构视图 = **分层全景**（一条系统边界 + 边界内若干职责层 + 边界外的存储与外部服务）。
  它替掉了从前的「目录聚合依赖图」：那张图画的是「哪些目录互相 import」，读者看完仍不知道
  这个系统由哪几层组成。

  2026-10-16 两条定案，都在这个文件里落地：
  - **只读**：方块不能拖。改图只有 Agent 一条路（`set_architecture`），界面上不留第二个写入口——
    两边各写一套，用户的修正就可能只活在浏览器里；
  - **一格 = 一个方块**：引擎把原子模块压成方块（旁证不画、同父小目录合并），一格可能是几个模块。
    点合并块展开成员，点成员才进节点详情；一层超过 6 格先折起，其余就地展开。
    文件数、占比这些元数据一律不上画布——要读就在对话里问 agent。

  引擎侧的 `edges` 照旧算、照旧进产物：它是「模型不许发明边」这条红线的落点（模型输出里的边一律丢弃），
  只是不再上画布（全景图里那几团线读不出东西，看往来有流程视图与节点详情）。

  两条不能混的口径：
  - 层名/归层 = 判断题（`source` 只有 `llm` 与 `unavailable` 两格：判过就画模型判的那份，没判过就整块说不可用，不再拿结构角色冒充分层）；
  - 边界之外那一栏 = 词典认出来的外部包，认不出的一律「未识别」，不当服务画出来。
*/

/** 「判一次分层」是花 token 的动作，确认框里要把量说清（一发 light 分层实测 ≈¥0.01~0.02）。 */
const REGEN_PRICE_NOTE = "一发轻量档调用（实测 ≈¥0.02）";

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
}

export const NO_ARCH_STATUS: ArchStatus = { source: null, reason: "", loading: false, generatedAt: "", layers: 0, externals: 0, collapsedExternals: 0, omittedModules: 0 };

type PlanView = ArchitecturePlan & { omittedModules: number; collapsedExternals: number };

/** 一层里默认露几格：压缩后仍超过这个数的层（本仓三层实测还有 10 格上下的）才折，其余一律不折。 */
const LAYER_PREVIEW = 6;
/** 方块按角色排：入口与主链路先露出来，底座和支撑排在后面（同层内部排序，不宣称谁在谁之上）。 */
const ROLE_ORDER: Record<string, number> = { entry: 0, core: 1, shared: 2, support: 3 };

/** 画布上的一格：引擎给的方块，可能是一个模块，也可能是几个同父小模块合起来的合并块。 */
interface Cell {
  id: string;
  layerId: string;
  title: string;
  role: string | null;
  /** 块里的成员节点（合并块长度 >1）：点成员才进节点详情。 */
  members: { id: string; node: CourseNode | undefined; title: string }[];
  overridden: boolean;
}

export function ArchOverview({ repositoryId, course, analysis, visible, selectedId, reloadNonce, onSelect, onStatus }: {
  repositoryId: string;
  course: CourseTree;
  analysis: RepositoryAnalysis;
  /** 取数闸门：三视图常驻挂载，隐藏面板不该替用户点这次请求（同 FlowMap）。 */
  visible: boolean;
  selectedId?: string;
  /** 父级 bump 一下就更取一次（覆盖层落盘后、切仓后、产物刷新后）。 */
  reloadNonce: number;
  onSelect: (node: CourseNode, scopePaths: string[]) => void;
  onStatus: (status: ArchStatus) => void;
}): ReactElement {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [regenNonce, setRegenNonce] = useState(0);

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
  }, [repositoryId, visible, reloadNonce, regenNonce]);

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

  const cells = useMemo<Cell[]>(() => {
    if (!plan) return [];
    const briefs = new Map((plan.blocks ?? []).map((block) => [block.id, block]));
    return plan.layers.flatMap((layer) => layer.moduleIds.map((blockId) => {
      const brief = briefs.get(blockId);
      const members = (brief?.members ?? [blockId]).map((moduleId) => {
        const node = nodesById.get(moduleId);
        return { id: moduleId, node, title: node?.title ?? moduleId };
      });
      return {
        id: blockId,
        layerId: layer.id,
        role: brief?.role ?? null,
        // 合并块的标题在产物里（像「枚举、文档」）；块被人工拆开或产物比树旧时退回成员名／原 id，不编一个看不出的名字
        title: brief?.title ?? members[0]?.title ?? blockId,
        members,
        overridden: layer.overridden === true || (plan.overriddenLayers ?? []).includes(layer.id)
      };
    }));
  }, [plan, nodesById]);

  /** 折起来的两处开关：整层剩下的方块、合并块的成员。都只活在这次读图里，不落盘也不进请求。 */
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
      ? { source: plan.source, reason: plan.reason ?? "", loading, generatedAt: plan.generatedAt, layers: plan.layers.length, externals: plan.externals.length, collapsedExternals: plan.collapsedExternals, omittedModules: plan.omittedModules }
      : { ...NO_ARCH_STATUS, loading });
  }, [plan, loading, emitStatus]);


  const toggle = (list: string[], setList: (next: string[]) => void, key: string): void => setList(list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);

  /** 原子块点一下就走节点详情；合并块先展开，成员那一层才绑作用域（`arch:` 的 id 课程树里查无此人）。 */
  const pick = (member: { node: CourseNode | undefined; title: string } | undefined): void => {
    if (!member?.node) {
      showToast(`产物比树旧：${member?.title ?? "这一格"}已不在当前课程树里`);
      return;
    }
    onSelect(member.node, filesOf(member.node));
  };

  const regenerate = (): void => {
    if (!window.confirm(`判一次分层会花一次模型调用（${REGEN_PRICE_NOTE}）。变的只有层名与谁归哪层，外部依赖不变；你的人工修正会作为输入一起送进去。要继续吗？`)) return;
    setLoading(true);
    api.regenerateArchitecture(repositoryId)
      .then((next) => { setPlan(next); showToast(next.source === "llm" ? "已按模型判断分好层" : `${UNAVAILABLE[next.unavailableReason ?? "not_judged"].title}：这次也没判成`); })
      .catch((reason: unknown) => showToast(reason instanceof Error ? reason.message : "判分层没成功"))
      .finally(() => setLoading(false));
  };

  if (!visible) return <div className="empty" aria-hidden />;
  if (error && !plan) return <EmptyState title="架构视图暂时不可用" detail={error} />;
  if (!plan) return <Loading />;

  if (plan.source === "unavailable") {
    const state = UNAVAILABLE[plan.unavailableReason ?? "not_judged"];
    return (
      <div className="arch-root">
        <div className="arch-unavailable">
          <Icon name="alert" size={18} />
          <div>
            <p className="arch-unavailable-title">{state.title}</p>
            <p className="arch-unavailable-note" title={`${plan.reason ?? ""}· 方块清单与边界之外那一栏都由程序算出，仍在这份产物里，问 agent 就有；它们要对着系统边界才读得出意思，所以这里不单独摊开。`}>{state.note}</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={loading || !state.retryable} title={state.retryable ? `${REGEN_PRICE_NOTE}。分层是判断题：不判就没有层可画。` : "这条路由不降级：没配模型时点它只会白跑一次"} onClick={regenerate}><Icon name="rotate" size={13} />判一次分层</button>
        </div>
      </div>
    );
  }


  return (
    <div className="arch-root">
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
          <div className="banner-text" title="方块数超过上限的仓只送前 80 格进分层，剩下这些没参与判断">{`只分层前 80 格，另 ${plan.omittedModules} 格没进来`}</div>
        </div>
      ) : null}
      <div className="arch-canvas">
        <div className="arch-boundary">
          <span className="arch-boundary-label" title="框内是这个仓自己写的代码，框外它只用不实现">系统边界</span>
          {plan.layers.map((layer) => {
            const layerCells = cells.filter((cell) => cell.layerId === layer.id)
              .sort((left, right) => (ROLE_ORDER[left.role ?? "support"] - ROLE_ORDER[right.role ?? "support"]) || left.title.localeCompare(right.title));
            const opened = openLayers.includes(layer.id);
            const shown = opened ? layerCells : layerCells.slice(0, LAYER_PREVIEW);
            const folded = layerCells.length - shown.length;
            return (
              <div key={layer.id} className="arch-layer">
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
                    // 选中的模块正好在被合起来的那格里时自动展开：从左栏点到哪儿，图上就得看得见那一格
                    const openedCell = openCells.includes(cell.id) || (grouped && cell.members.some((member) => member.node?.id === selectedId));
                    return (
                      <div key={cell.id} className="arch-cell">
                        <button
                          type="button"
                          className={`arch-module${grouped ? " grouped" : ""}${cell.overridden ? " moved" : ""}${!grouped && selectedId === cell.id ? " selected" : ""}`}
                          title={grouped ? "这一格合起了几个小模块，点开看成员" : undefined}
                          onClick={() => (grouped ? toggle(openCells, setOpenCells, cell.id) : pick(cell.members[0]))}
                        >
                          <span className="arch-module-name">{cell.title}</span>
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
                      title={`这一层共 ${layerCells.length} 格，默认露 ${LAYER_PREVIEW} 格；折起来的没删，点开还在`}
                      onClick={() => toggle(openLayers, setOpenLayers, layer.id)}
                    >{opened ? "收起" : `另有 ${folded} 格`}</button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {plan.externals.length ? (
          <div className="arch-outside">
            {[...externalsByCategory.entries()].map(([category, rows]) => (
              <div className="arch-outside-group" key={category}>
                <span className="arch-outside-label">{EXTERNAL_CATEGORY_LABEL[category]}</span>
                <div className="arch-outside-rows">
                  {rows.map((row) => (
                    <span className="arch-external" key={row.display} title={row.identities.join("、")}>
                      {row.display}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flow-legend">
        <span className="fs-11 faint" title="图上这些方块只读：点一下看详情。要挪层或改层名，在右边对话里说一声，agent 走 set_architecture 写。">分层判错了？在对话里让 agent 挪</span>
        <div className="grow" />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={loading}
          title={`重问一次模型怎么分层：${REGEN_PRICE_NOTE}。边界外那一栏不变——它从来不是模型算的。`}
            onClick={regenerate}
        ><Icon name="rotate" size={13} />判一次分层</button>
      </div>
    </div>
  );
}
