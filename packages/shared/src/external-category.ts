/**
  外部包的分类档。类型放在 shared（图上的「边界之外」栏与它对得上），
  具体词典在引擎侧 `depgraph/external-catalog.ts`（那是数据，且只覆盖真实遇到的包）。
  `stdlib` 单列：语言自带的东西不算「系统之外」，混进 `other` 会把那一栏灌满噪声。
  `other` 的界面档名叫「未识别」而不是「外部依赖」——没认出来就别说自己知道它是什么。
*/
export type ExternalCategory = "database" | "cache" | "queue" | "model" | "http-client" | "framework" | "testing" | "stdlib" | "other";

export const EXTERNAL_CATEGORY_LABEL: Record<ExternalCategory, string> = {
  database: "数据存储",
  cache: "缓存",
  queue: "队列",
  model: "模型服务",
  "http-client": "外部接口",
  framework: "框架与库",
  testing: "测试框架",
  stdlib: "语言自带",
  other: "未识别"
};
