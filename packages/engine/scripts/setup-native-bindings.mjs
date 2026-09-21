import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const platform = process.platform;
const arch = process.arch;

if (platform !== "darwin" || arch !== "arm64") {
  console.log(`[setup:native] skip bundled better-sqlite3 bindings on ${platform}-${arch}; using package install/rebuild output`);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "setup-native-bindings.sh");
const result = spawnSync("bash", [script], { stdio: "inherit" });

process.exit(result.status ?? 1);
