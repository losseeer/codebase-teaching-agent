import type { Diagram, DiagramBody, DiagramSummary } from "@codebase-tutor/domain";

/**
  画布那张图的存取口，**绑定在一个仓上**（适配器由 `infrastructure/canvas-tools.ts` 就地闭包出这一仓的库句柄与仓 id，
  所以这里每一格都不必再带 repositoryId）。
  结构写入口（`diagram/set-diagram.ts`）只用其中五格；整条用例面——列、建、读、改名、几何、恢复、删——要十格。
  两边都不认识 SQLite，也不认识行形状。
  实现方不 import 这个接口（「持久层反过来认识领域」是守卫要拦的），结构对齐由注入点的赋值检查。
*/
export interface DiagramStore {
  /** 图库清单：只回摘要（名字、谁建的、几版、多少图元），不拖结构进来。 */
  list(): DiagramSummary[];
  /** 一张图连它的版本历史；解析不出结构就当没有——半张图会被画成一张完整的图，宁可没有。 */
  read(diagramId: string): Diagram | undefined;
  /** 图库里不撞名的那一个：撞名加序号是图库的规则，而它必须知道现有的名字，所以留在这一侧。 */
  uniqueName(wanted: string): string;
  /** agent 一次画完整张图：落第一行。空白图不存第一版，它还没有结构可回。 */
  insert(diagram: Diagram): Diagram;
  /** 一批结构改动：写正文并自动存一版；`note` 是「这次改了什么」的人话。 */
  applyStructure(diagram: Diagram, body: DiagramBody, note: string): Diagram;
  /** 界面新建的一张空白图：名字撞了按图库规则加序号（一个仓可以有很多张图）。 */
  createBlank(name?: string): Diagram;
  /** 改名：不存版本（它不动结构）。返回 `undefined` 表示「一个字都没改」或「名字为空」，由调用方分清两条 400。 */
  rename(diagram: Diagram, name: string): Diagram | undefined;
  /** 几何落盘：认不出的节点 id 一个个跳过，不因为一次陈旧拖拽在图上造出新节点。 */
  saveGeometry(diagram: Diagram, positions: readonly { id: string; x: number; y: number }[]): Diagram;
  /** 恢复某一版：恢复动作本身也存一版（为什么不能截断历史见实现方的 `restoreVersion`）。 */
  restore(diagram: Diagram, index: number): Diagram | undefined;
  /** 删掉一张图：版本历史一起没，所以审计要先拿住名字与版数。 */
  delete(diagram: Diagram): void;
}
