// 正例（带注释干扰）：真启动语句缩在函数里，注释里那行假登记不能被当成证据。
import express from "express";

const app = express();

export function serve(): void {
  // app.get("/health", handler);
  app.listen(3000);
}
