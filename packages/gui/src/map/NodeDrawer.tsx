import type { DiagramNode, DiagramEdge } from "@codebase-tutor/domain";

import type {ReactElement } from "react";
import { Icon } from "../ui/icons";
import { ORIGIN_SHORT } from "./diagramView";

/** 取文件名部分；整条路径进 title。 */
function fileTail(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** 节点引用的核对读数：引用核上了就带上它覆盖的文件；核不上就说清原因。 */
export type NodeResolution =
  | { state: "ok"; files: DrawerFile[] }
  | { state: "stale"; reason: string }
  | { state: "pending" }
  | { state: "unknown" };

export interface DrawerFile {
  path: string;
  line: number;
  label?: string;
}

/** 出边加去向节点名，由调用方算好传入。 */
export type DrawerEdge = { edge: DiagramEdge; toLabel: string };

/** 依据行：static/code 按长度截，inferred 只显示可信度。 */
function evidenceLine(edge: DiagramEdge): string {
  if (edge.origin === "inferred") return ORIGIN_SHORT[edge.origin];
  const head = (edge.evidence || "").split(/[；;]/)[0].trim();
  return head.length > 46 ? `${head.slice(0, 46)}…` : head || "这条关系没有记录依据";
}

/** 节点抽屉：读数面板，无结构编辑入口。 */
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
  const badgeText = isNote ? (node.sub ?? "便签") : resolution.state === "ok" ? "代码实体" : "节点";

  return (
    <aside className="drawer" aria-label="节点详情">
      <div className="drawer-head">
        <h3>{node.label}</h3>
        <span className="badge badge-neutral" title={isNote ? "正文由人或模型写" : resolution.state === "ok" ? "已对应到文件" : "没对应到文件"}>{badgeText}</span>
        <button type="button" className="icon-btn" aria-label="关闭详情" title="关闭详情" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <div className="drawer-body">
        <div className="kv">
          <span className="kv-k">说明</span>
          {isNote ? (
            node.text
              ? <span className="kv-v" title="正文由人或模型写">{node.text}</span>
              : <span className="kv-v muted">这张便签还是空的。</span>
          ) : resolution.state === "ok" ? (
            <span className="kv-v">已对应到 {resolution.files.length} 个文件</span>
          ) : resolution.state === "stale" ? (
            <>
              <span className="kv-v"><span className="badge badge-warn">引用已失效</span></span>
              <span className="kv-v muted" title={resolution.reason}>{resolution.reason}</span>
            </>
          ) : resolution.state === "pending" ? (
            <span className="kv-v muted">暂时取不到文件清单</span>
          ) : (
            <span className="kv-v muted">{node.ref ? "这个引用没找到对应文件。" : "这个节点没有指向文件的引用。"}</span>
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
                  <span className={`flow-origin origin-${edge.origin}`} title={edge.downgraded ? "依据偏弱" : undefined}>{ORIGIN_SHORT[edge.origin]}</span>
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
            title={isNote ? "便签不指向代码节点" : resolution.state === "ok" ? "带着这个节点的第一个文件去代码教学" : "这个节点的引用已失效，没有可去的教学域"}
            onClick={onGotoTeach}
          ><Icon name="book" size={13} />去代码教学</button>
          <button type="button" className="btn btn-ghost btn-sm" title="把这个节点设为对话的教学域" onClick={onBind}><Icon name="zap" size={13} />绑定到对话</button>
        </div>

        {/* */}
        <p className="dg-drawer-foot">
        </p>
      </div>
    </aside>
  );
}
