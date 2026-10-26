import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
  产品数据目录（`~/.codebase-tutor/`）的四处落点共用一个来源：引擎线 `engine.jsonl`、对账线 `llm.log`、
  地址簿 `repositories.json`、模型设置 `llm-settings.json`。

  离线测试（`VITEST`）改指临时目录：测试会挂载临时仓、写审计线、存设置，默认落点若指向真目录，
  一次 `pnpm test` 就往用户的对账线与地址簿里掺进假读数。有的测试文件在 afterEach 里 `delete` 掉自己的
  env 覆盖，落点就退回真目录，所以判据不能只靠环境变量。
*/
export function tutorDataDir(): string {
  return process.env.VITEST === "true" ? join(tmpdir(), "codebase-tutor-vitest") : join(homedir(), ".codebase-tutor");
}
