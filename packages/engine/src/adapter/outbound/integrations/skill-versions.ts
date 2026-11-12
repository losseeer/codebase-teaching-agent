/** 技能版本链：写入前记录当前状态，写入后追加一版；记录只读，不参与提示词。 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSIONS_DIR = ".versions";

export type VersionSource = "migration" | "user" | "agent-proposal" | "reset";

export interface SkillVersion {
  version: number;
  parent: number | null;
  source: VersionSource;
  at: string;
  reason: string;
  changed: string[];
  check: { errors: number; warnings: number };
  fingerprint: string;
  files: Record<string, string>;
}

function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    if (name === VERSIONS_DIR) continue;
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

function hashesOf(skillDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of listFiles(skillDir).sort()) {
    out[name] = createHash("sha256").update(readFileSync(join(skillDir, name))).digest("hex").slice(0, 16);
  }
  return out;
}

export function fingerprintOf(skillDir: string): string {
  return createHash("sha256").update(JSON.stringify(hashesOf(skillDir))).digest("hex").slice(0, 16);
}

export function readSkillVersions(skillDir: string): SkillVersion[] {
  const dir = join(skillDir, VERSIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(dir, name), "utf8")) as SkillVersion];
      } catch {
        return [];
      }
    });
}

function writeVersion(
  skillDir: string,
  record: { source: VersionSource; at: string; reason: string; check: { errors: number; warnings: number } },
  files: Record<string, string>,
  changed: string[]
): SkillVersion {
  const existing = readSkillVersions(skillDir);
  const version = (existing.at(-1)?.version ?? 0) + 1;
  const full: SkillVersion = {
    version,
    parent: existing.at(-1)?.version ?? null,
    source: record.source,
    at: record.at,
    reason: record.reason,
    changed,
    check: record.check,
    fingerprint: createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16),
    files
  };
  const dir = join(skillDir, VERSIONS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `v${String(version).padStart(3, "0")}.json`), `${JSON.stringify(full, null, 2)}\n`, "utf8");
  return full;
}

/** 写入前调用：链为空时记迁移首版（收进用户已有内容）；当前内容与最新版不同则记一版外部改动。 */
export function ensureCurrentVersion(
  skillDir: string,
  input: { reason: string; check?: { errors: number; warnings: number } }
): SkillVersion {
  const existing = readSkillVersions(skillDir);
  const files = hashesOf(skillDir);
  const check = input.check ?? { errors: 0, warnings: 0 };
  if (!existing.length) {
    return writeVersion(skillDir, { source: "migration", at: new Date().toISOString(), reason: input.reason, check }, files, Object.keys(files));
  }
  const latest = existing.at(-1)!;
  if (latest.fingerprint === createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16)) return latest;
  const changed = Object.keys(files).filter((name) => files[name] !== latest.files[name]);
  return writeVersion(skillDir, { source: "user", at: new Date().toISOString(), reason: input.reason, check }, files, changed);
}

/** 写入后调用：内容与最新版一致时不追加。 */
export function appendVersion(
  skillDir: string,
  input: { source: VersionSource; reason: string; check: { errors: number; warnings: number } }
): SkillVersion {
  const latest = readSkillVersions(skillDir).at(-1);
  const files = hashesOf(skillDir);
  const fingerprint = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16);
  if (latest?.fingerprint === fingerprint) return latest;
  const changed = Object.keys(files).filter((name) => files[name] !== latest?.files?.[name]);
  return writeVersion(skillDir, { source: input.source, at: new Date().toISOString(), reason: input.reason, check: input.check }, files, changed);
}
