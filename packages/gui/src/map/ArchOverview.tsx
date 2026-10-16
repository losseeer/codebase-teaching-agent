import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { EXTERNAL_CATEGORY_LABEL, type ArchitecturePlan, type CourseNode, type CourseTree, type ExternalCategory, type RepositoryAnalysis, type RepositoryIndex } from "@codebase-tutor/shared";
import { api } from "../api/client";
import { EmptyState, flatten, Loading } from "../views/helpers";
import { Icon } from "../ui/icons";
import { edgeCaveatOf, percent } from "./language-caveat";
import { applyOverride } from "../modules/server-overlays";
import { showToast } from "../modules/toast";

/**
  架构视图 = **分层全景**（一条系统边界 + 边界内若干职责层 + 边界外的存储与外部服务）。
  它替掉了从前的「目录聚合依赖图」：那张图画的是「哪些目录互相 import」，读者看完仍不知道
  这个系统由哪几层组成；而分层判断是模型给的、可错，所以**人工修正通道与图同期落地**——
  方块可以拖到别的层（写走 `POST .../overlays/apply`，与 Agent 工具同一条路径），一次拖动都不花钱。

  2026-10-16 用户定：**这张图不画跨层箭头**。层带之间那几团线读不出东西（同一对层的边共用同一组端点，
  叠成一条带子），而依赖关系本来就不该由这张全景图承担——要看往来有「流程视图」与节点详情里的上下游。
  引擎侧的 `edges` 照旧算、照旧进产物：它是「模型不许发明边」这条红线的落点（模型输出里的边一律丢弃），
  只是不再上画布。

  两条不能混的口径：
  - 层名/归层 = 判断题（`source` 说清是模型判的还是静态兜底，降级在横幅里如实写）；
  - 边界之外那一栏 = 词典认出来的外部包，认不出的一律「未识别」，不当服务画出来。
*/

/** 「重新分层」是花 token 的动作，确认框里要把量说清（一发 light 分层实测 ≈¥0.01~0.02）。 */
const REGEN_PRICE_NOTE = "一发轻量档调用（实测 ≈¥0.02）";

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

/** 层内方块：模块 id 就是课程树里的模块节点 id，点它走既有的节点详情与作用域绑定。 */
interface Block {
  moduleId: string;
  layerId: string;
  layerName: string;
  node: CourseNode | undefined;
  title: string;
  files: number;
  lines: number;
  hot: number;
  overridden: boolean;
}

export function ArchOverview({ repositoryId, course, index, analysis, visible, selectedId, reloadNonce, onSelect, onStatus }: {
  repositoryId: string;
  course: CourseTree;
  index: RepositoryIndex;
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
  const [drag, setDrag] = useState<{ module: string; from: string; x: number; y: number } | null>(null);
  const bandsRef = useRef<Map<string, HTMLDivElement>>(new Map());

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
  const linesOf = useMemo(() => {
    const map = new Map<string, number>();
    for (const file of index.files) map.set(file.path, file.lines);
    return map;
  }, [index]);
  const hotOf = useMemo(() => {
    const map = new Map<string, number>();
    for (const spot of index.hotspots) map.set(spot.path, spot.changes);
    return map;
  }, [index]);

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

  const blocks = useMemo<Block[]>(() => {
    if (!plan) return [];
    return plan.layers.flatMap((layer) => layer.moduleIds.map((moduleId) => {
      const node = nodesById.get(moduleId);
      const files = filesOf(node);
      return {
        moduleId,
        layerId: layer.id,
        layerName: layer.name,
        node,
        title: node?.title ?? moduleId,
        files: files.length,
        lines: files.reduce((sum, path) => sum + (linesOf.get(path) ?? 0), 0),
        hot: files.reduce((max, path) => Math.max(max, hotOf.get(path) ?? 0), 0),
        overridden: layer.overridden === true || (plan.overriddenLayers ?? []).includes(layer.id)
      };
    }));
  }, [plan, nodesById, filesOf, linesOf, hotOf]);

  const caveat = useMemo(() => edgeCaveatOf(analysis.languageProfile), [analysis.languageProfile]);
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

  /**
    一次人工修正：落盘走引擎（校验 + 审计都在那里），成功后**重取产物**而不是本地挪方块——
    界面自己算的那份归属会与引擎的读数打架（层带计数、`overriddenLayers` 都以引擎为准）。
  */
  const applyIntent = useCallback((intent: Parameters<typeof api.applyOverlay>[1], onDone?: (ok: boolean, text: string) => void): void => {
    // applyOverride 不抛：拒写正文（引擎那句原话）与连不上引擎是两条不同的话，都由它按状态分好再交出来
    void applyOverride(repositoryId, intent).then((outcome) => {
      if (onDone) onDone(outcome.ok, outcome.text);
      else showToast(outcome.text);
      if (outcome.ok) api.getArchitecture(repositoryId).then(setPlan).catch(() => undefined);
    });
  }, [repositoryId]);

  const onDrop = useCallback((moduleId: string, fromLayer: string, clientX: number, clientY: number): void => {
    const target = plan?.layers.find((layer) => {
      const el = bandsRef.current.get(layer.id);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    });
    if (!target || target.name === fromLayer) return;
    // 成功才报「已挪好」；拒写（层被改名、模块不在树里）时把引擎那句原话交出来，别替它圆场
    applyIntent({ kind: "move_module", module: moduleId, layer: target.name, from: fromLayer }, (ok, text) => showToast(ok ? `已挪到「${target.name}」` : text));
  }, [plan, applyIntent]);

  const startDrag = (event: ReactPointerEvent, block: Block): void => {
    if (!block.node) return; // 树里查不到的模块（旧产物留下的 id）不做拖拽目标：改了也看不出效果
    event.preventDefault();
    setDrag({ module: block.moduleId, from: block.layerName, x: event.clientX, y: event.clientY });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent): void => setDrag((current) => (current ? { ...current, x: event.clientX, y: event.clientY } : current));
    const up = (event: PointerEvent): void => {
      const active = drag;
      setDrag(null);
      onDrop(active.module, active.from, event.clientX, event.clientY);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [drag, onDrop]);

  if (!visible) return <div className="empty" aria-hidden />;
  if (error && !plan) return <EmptyState title="架构视图暂时不可用" detail={error} />;
  if (!plan) return <Loading />;

  return (
    <div className="arch-root">
      {plan.source === "static" ? (
        <div className="banner banner-warn">
          <Icon name="alert" size={14} />
          <div className="banner-text" title={`${plan.reason ? `${plan.reason}。` : ""}三档结构角色不是职责分层，别拿它讲架构；要模型判一次，点右边的「重新分层」（${REGEN_PRICE_NOTE}）`}>
            <strong>{`${plan.reason ? plan.reason.split(/[：（]/)[0].slice(0, 14) : "分层没判"}｜静态分层兜底`}</strong>
          </div>
        </div>
      ) : null}
      {plan.omittedModules ? (
        <div className="banner banner-info">
          <Icon name="info" size={14} />
          <div className="banner-text" title="超过 80 个模块的仓只送前 80 个进分层，剩下这些没参与判断">{`只分了前 ${blocks.length ? 80 : 0} 个模块，另 ${plan.omittedModules} 个没进来`}</div>
        </div>
      ) : null}
      <div className="arch-canvas">
        <div className="arch-boundary">
          <span className="arch-boundary-label" title="框内是这套系统自己写的代码；框外的东西它只用不实现">系统边界</span>
          {plan.layers.map((layer) => (
            <div
              key={layer.id}
              className={`arch-layer${blocks.some((block) => block.layerId === layer.id && block.moduleId === drag?.module) ? " drop-hint" : ""}`}
              ref={(el) => {
                if (el) bandsRef.current.set(layer.id, el);
                else bandsRef.current.delete(layer.id);
              }}
            >
              <div className="arch-layer-head">
                <span className="arch-layer-name" title={layer.duty}>
                  {layer.name}
                  {layer.overridden ? <span className="arch-override-dot" title="这层的名字是人工改过的，不是模型起的" /> : null}
                </span>
                <span className="arch-layer-duty">{layer.duty}</span>
              </div>
              <div className="arch-layer-blocks">
                {blocks.filter((block) => block.layerId === layer.id).map((block) => {
                  const files = filesOf(block.node);
                  return (
                    <button
                      key={block.moduleId}
                      type="button"
                      className={`arch-module${selectedId === block.moduleId ? " selected" : ""}${drag?.module === block.moduleId ? " dragging" : ""}${block.overridden ? " moved" : ""}`}
                      title={`${block.title} · ${block.files} 个文件 · ${block.lines.toLocaleString()} 行${block.hot ? ` · Git 热点约 ${block.hot} 次变更` : ""}\n点一下看详情 · 按住拖到别的层就是人工修正（不花钱）`}
                      onPointerDown={(event) => startDrag(event, block)}
                      onClick={() => {
                        if (!block.node) {
                          showToast("这个模块在当前课程树里查不到（产物比树旧），重新导入后可恢复正常");
                          return;
                        }
                        onSelect(block.node, files);
                      }}
                    >
                      <span className="arch-module-name">{block.title}</span>
                      <span className="arch-module-meta">
                        <span>{`${block.files} 文件 · ${block.lines.toLocaleString()} 行`}</span>
                        {block.hot >= 5 ? <span className="hot-dot">{`● ${block.hot}`}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="arch-outside">
          {[...externalsByCategory.entries()].map(([category, rows]) => (
            <div className="arch-outside-group" key={category}>
              <span className="arch-outside-label" title={`${EXTERNAL_CATEGORY_LABEL[category]}：由 import 的外部包名经确定性词典认出，模型不参与分类`}>{EXTERNAL_CATEGORY_LABEL[category]}</span>
              <div className="arch-outside-rows">
                {rows.map((row) => (
                  <span className="arch-external" key={row.display} title={`用到它的文件：${row.usedBy} 个\n包名身份：${row.identities.join("、")}`}>
                    {`${row.display} · ${row.usedBy}`}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {plan.externalsNote ? <span className="fs-11 faint" title={plan.externalsNote}>{plan.externalsNote}</span> : null}
          {!plan.externals.length && !plan.externalsNote ? <span className="fs-11 faint">这份产物的图里没画出边界外的东西</span> : null}
          {plan.collapsedExternals ? (
            <span className="fs-11 faint" title={`未识别与语言自带的不画进图：认不出名字就不知道它是不是外部服务（实测 Python 的自有包也会落在这里）`}>{`另有 ${plan.collapsedExternals} 类未识别 / 语言自带`}</span>
          ) : null}
        </div>
        {drag ? (
          <div className="arch-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden>
            {blocks.find((block) => block.moduleId === drag.module)?.title ?? drag.module}
          </div>
        ) : null}
      </div>
      <div className="flow-legend">
        <span className="badge badge-neutral" title="框内 = 这个仓自己写的代码；框外 = 它只用不实现的东西">{`${plan.layers.length} 层 · ${blocks.length} 个模块`}</span>
        {caveat ? <span className="badge badge-warn" title={caveat.detail}>{caveat.label}</span> : null}
        <span className="fs-11 faint" title="这张全景图不画跨层依赖：往来条数读得出粗细读不出因果，要看依赖走「流程视图」与节点详情。拖动方块换层只挪归属，不产生任何调用。">
          拖动方块换层（不花钱）
        </span>
        <span className="fs-11 faint mono" title={`覆盖主语言的依赖边强度；文件数占比见悬停`}>
          {`${percent(analysis.languageProfile?.graphFileShare ?? 0)} 的文件在图里`}
        </span>
        <div className="grow" />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={loading}
          title={`重问一次模型怎么分层：${REGEN_PRICE_NOTE}。边界外那一栏不变——它从来不是模型算的。`}
          onClick={() => {
            if (!window.confirm(`重新分层会花一次模型调用（${REGEN_PRICE_NOTE}）。变的只有层名与谁归哪层，外部依赖不变；你的人工修正会作为输入一起送进去。要继续吗？`)) return;
            api.regenerateArchitecture(repositoryId)
              .then((next) => { setPlan(next); showToast(`已按 ${next.source === "llm" ? "模型判断" : "静态兜底"}重新分层`); })
              .catch((reason: unknown) => showToast(reason instanceof Error ? reason.message : "重新分层没成功"));
          }}
        ><Icon name="rotate" size={13} />重新分层</button>
      </div>
    </div>
  );
}
