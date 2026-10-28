import type { Diagram, DiagramBody, DiagramSummary } from "@codebase-tutor/domain";

/** 画布那张图的存取口，绑定在一个仓上（适配器闭包库句柄与仓 id，故每格不带 repositoryId）。 */
export interface DiagramStore {
  /** 图库清单：只回摘要，不含结构。 */
  list(): DiagramSummary[];
  /** 一张图连它的版本历史；结构解析不出返回 `undefined`。 */
  read(diagramId: string): Diagram | undefined;
  /** 按图库规则给 `wanted` 生成一个不撞名的名字。 */
  uniqueName(wanted: string): string;
  /** 一次写入完整的一张图（第一版）；空白图不存第一版。 */
  insert(diagram: Diagram): Diagram;
  /** 一批结构改动：写正文并自动存一版；`note` 记录本次改动。 */
  applyStructure(diagram: Diagram, body: DiagramBody, note: string): Diagram;
  /** 新建一张空白图；名字撞了按图库规则加序号。 */
  createBlank(name?: string): Diagram;
  /** 改名不存版本；返回 `undefined` 表示名字未变或为空。 */
  rename(diagram: Diagram, name: string): Diagram | undefined;
  /** 落盘几何；认不出的节点 id 跳过。 */
  saveGeometry(diagram: Diagram, positions: readonly { id: string; x: number; y: number }[]): Diagram;
  /** 恢复某一版；恢复动作本身也存一版。 */
  restore(diagram: Diagram, index: number): Diagram | undefined;
  /** 删除一张图，版本历史一并删除。 */
  delete(diagram: Diagram): void;
}
