import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 产品数据目录 `~/.codebase-tutor/`；VITEST 下改指临时目录，避免写入真实数据。 */
export function tutorDataDir(): string {
  return process.env.VITEST === "true" ? join(tmpdir(), "codebase-tutor-vitest") : join(homedir(), ".codebase-tutor");
}
