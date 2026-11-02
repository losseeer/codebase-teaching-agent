/** 路由端点：提供方与消费方各一条，供注册索引与路由识别共用。 */
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
