/**
  跨语言 HTTP 接缝：前端那条 `request.get('/shop/list')` 与后端 `@GetMapping("/list")` 之间
  没有任何语法级依赖——两边唯一的共享标识符是路由字符串，所以整仓依赖图天生看不见这条链。
  类型放共享层是因为两侧都要读（界面要显示「这条链的另一头在哪个仓的哪一行」）。
  识别与配对逻辑住在 engine `depgraph/url-routes.ts`，这里只定契约。
*/
export interface RouteProvider {
  /** 归一化后的路由：带前导斜杠，参数段统一折成 `{*}` */
  route: string;
  path: string;
  line: number;
  /** 怎么认出这条路由的（界面用白话说「这是 Spring 的注解」） */
  framework: "spring" | "flask" | "fastapi";
}

export interface RouteConsumer {
  route: string;
  path: string;
  line: number;
  /** 原始字面量：归一化会吃掉 `${id}` 这类信息，排查与界面都要看原文 */
  raw: string;
}

export interface RouteLink {
  route: string;
  consumer: RouteConsumer;
  provider: RouteProvider;
  /** `exact`=整段相等；`suffix`=提供方路由按整段落在消费方尾部（网关前缀那一类）。两者证据强度不同，不能混成一个数 */
  via: "exact" | "suffix";
  /** 这条消费串一共配到几个提供方。1 之外都是歧义，必须被数出来而不是静默取第一个 */
  ambiguousWith: number;
}

/** 一个方向的配对结果（带统计，界面不用自己再数一遍）。 */
export interface SeamDirection {
  links: RouteLink[];
  /** 这一侧被扫到的路由字符串/路由声明条数 */
  scanned: number;
  matched: number;
  ambiguous: number;
}

/** 本仓↔相关仓的双向接缝清单。界面上不再有这条入口，它是 agent 的 `cross_repo_link` 工具背后的数据。 */
export interface SeamReport {
  repositoryId: string;
  otherRepositoryId: string;
  /** 本仓调用相关仓的接口（本仓是消费方） */
  outbound: SeamDirection;
  /** 相关仓调用本仓的接口（本仓是提供方） */
  inbound: SeamDirection;
}
