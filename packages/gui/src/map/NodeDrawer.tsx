import type { ReactElement } from "react";
import type { CourseNode, DiagramEdge, DiagramNode } from "@codebase-tutor/shared/wire";
import { Icon } from "../ui/icons";
import { ORIGIN_NOTE } from "./diagramView";

/** 文件路径只露文件名：抽屉只有 `--drawer-w` 宽，整条路径读不完，全路径进 title。 */
function fileTail(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** 节点在课程树里的落点读数。四种状态各有各的一句话：查不到就说查不到。 */
export type NodeResolution =
  | { state: "ok"; node: CourseNode }
  | { state: "stale"; reason: string }
  | { state: "pending" }
  /** `ref` 指的是架构方块（`arch:…`）：它本来就不在课程树里，这边读不到它的摘要。 */
  | { state: "block" }
  | { state: "unknown" };

export interface DrawerFile {
  path: string;
  line: number;
  label?: string;
}

/** 一条出边连同它的去向节点名：抽屉拿不到整张图，去向标签由调用方算好递进来。 */
export type DrawerEdge = { edge: DiagramEdge; toLabel: string };

/**
  依据那一句怎么落笔：`static`/`code` 是行级事实（路径:行号），照原样给、只按长度截；
  `inferred` 那格的真内容就是模型自述，所以正文只说这一档意味着什么，原话整段留在悬停里。
*/
function evidenceLine(edge: DiagramEdge): string {
  if (edge.origin === "inferred") return ORIGIN_NOTE[edge.origin];
  const head = (edge.evidence || "").split(/[；;]/)[0].trim();
  return head.length > 46 ? `${head.slice(0, 46)}…` : head || "引擎没记下这条的依据";
}

/**
  节点抽屉：说明 / 关联文件 / 出边 / 两个动作 / 那行权限说明。
  它是读数面板、不是编辑器：这里没有改结构的入口（加删节点、连线只走对话里的 agent），位置也不在这一格。
*/
export function NodeDrawer({ node, outgoing, files, resolution, onClose, onOpenFile, onGotoTeach, onBind }: {
  node: DiagramNode;
  outgoing: DrawerEdge[];
  files: DrawerFile[];
  resolution: NodeResolution;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onGotoTeach: () => void;
  onBind: () => void;
}): ReactElement {
  const isNote = node.kind === "note";
  const badgeText = isNote ? (node.sub ?? "便签") : resolution.state === "ok" ? "模块" : "节点";

  return (
    <aside className="drawer" aria-label="节点详情">
      <div className="drawer-head">
        <h3>{node.label}</h3>
        <span className="badge badge-neutral" title={isNote ? "便签：正文由人或模型写，不是引擎读数" : resolution.state === "ok" ? "挂在课程树的一个节点上" : "引用核不到课程树"}>{badgeText}</span>
        <button type="button" className="icon-btn" aria-label="关闭详情" title="关闭详情" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <div className="drawer-body">
        <div className="kv">
          <span className="kv-k">说明</span>
          {isNote ? (
            node.text
              ? <span className="kv-v" title="这是人/模型写的正文，不是引擎读数">{node.text}</span>
              : <span className="kv-v muted">这张便签还是空的。</span>
          ) : resolution.state === "ok" ? (
            <span className="kv-v" title={`课程树里「${resolution.node.title}」的摘要（引擎算的），agent 没给画布另写一句`}>{resolution.node.summary}</span>
          ) : resolution.state === "stale" ? (
            <>
              <span className="kv-v"><span className="badge badge-warn">引用已失效</span></span>
              <span className="kv-v muted" title={resolution.reason}>{resolution.reason}</span>
            </>
          ) : resolution.state === "pending" ? (
            <span className="kv-v muted">课程树还没取到，这一格暂时没有可核对的说明。</span>
          ) : resolution.state === "block" ? (
            <span className="kv-v muted" title={`引用：${node.ref}`}>这一格挂在架构方块上，摘要要在对话里问 agent。</span>
          ) : (
            <span className="kv-v muted">{node.ref ? `引用 ${node.ref} 不在现在的课程树里。` : "这个模块节点没带引用。"}</span>
          )}
        </div>

        {!isNote && files.length ? (
          <div className="kv">
            <span className="kv-k">{`关联文件（${files.length}）`}</span>
            <div className="row-wrap">
              {files.map((file) => (
                <button
                  key={`${file.path}:${file.line}`}
                  type="button"
                  className="anchor-chip"
                  title={`${file.path}:${file.line}${file.label ? ` · ${file.label}` : ""}`}
                  onClick={() => onOpenFile(file.path)}
                >
                  <Icon name="file" size={12} />
                  <span>{`${fileTail(file.path)}:${file.line}`}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="kv">
          <span className="kv-k">{`出边（${outgoing.length}）`}</span>
          {outgoing.length ? (
            <div className="dg-out-rows">
              {outgoing.map(({ edge, toLabel }) => (
                <div className="dg-out-row" key={edge.id}>
                  <span className={`flow-origin origin-${edge.origin}`} title={`${ORIGIN_NOTE[edge.origin]}${edge.downgraded ? ` · 被引擎降档：${edge.downgraded}` : ""}`}>{edge.origin}</span>
                  <span title={edge.label ? `关系名：${edge.label}` : undefined}>{`→ ${toLabel}`}</span>
                  <span className="faint dg-edge-evidence" title={edge.origin === "inferred" ? (edge.evidence || undefined) : undefined}>{evidenceLine(edge)}</span>
                </div>
              ))}
            </div>
          ) : <span className="kv-v muted">这张图里它没有记出的去向。</span>}
        </div>

        <div className="row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={isNote || resolution.state !== "ok"}
            title={isNote ? "便签不指向代码节点" : resolution.state === "ok" ? "带着这个模块去代码教学" : "这个引用在课程树里查不到，没有可去的教学节点"}
            onClick={onGotoTeach}
          ><Icon name="book" size={13} />去代码教学</button>
          <button type="button" className="btn btn-ghost btn-sm" title="把这一格设为对话的作用域" onClick={onBind}><Icon name="zap" size={13} />绑定到对话</button>
        </div>

        {/* 权限说明只在这一处（画布不重复）：结构归 agent，几何归你。 */}
        <p className="dg-drawer-foot">
          <span>加删节点、连线：在对话里说。</span>
          <span>拖动位置：自由，且不存版本。</span>
        </p>
      </div>
    </aside>
  );
}
