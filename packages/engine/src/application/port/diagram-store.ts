import type { Diagram, DiagramBody, DiagramSummary } from "@codebase-tutor/domain";

/**
  画布那张图的存取口，**绑定在一个仓上**（适配器由 `application/canvas-tools.ts` 就地闭包出这一仓的库句柄与仓 id，
  所以这里每一格都不必再带 repositoryId）。
  `diagram/set-diagram.ts` 是画布结构的唯一写入口，它要的只是这五格——不认识 SQLite，也不认识行形状。
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
}
