import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const configName = ".tutorignore";

// This seed is materialized in each imported repository. Matching only reads .tutorignore.
const defaultTutorIgnoreContents = `# Codebase Tutor analysis exclusions.
# Supports comments, *, ?, **, directory suffixes and ! re-inclusion rules.

# Engine and VCS metadata
.git/
.tutor/
.DS_Store

# Agent workspaces
.claude/
.workbuddy/
.codex/
.cursor/
.aider/
.continue/
.roo/
.windsurf/

# Dependencies, builds and local caches
node_modules/
bower_components/
dist/
build/
.next/
.turbo/
coverage/
.cache/
__pycache__/
.pytest_cache/
.mypy_cache/
.venv/
venv/
target/
`;

interface IgnoreRule {
  raw: string;
  negate: boolean;
  directoryOnly: boolean;
  basenameOnly: boolean;
  anchored: boolean;
  expression: RegExp;
  staticPrefix: string;
}

export interface TutorIgnoreMatcher {
  ignores(relativePath: string, isDirectory?: boolean): boolean;
  shouldTraverse(relativeDirectory: string): boolean;
}

export function createTutorIgnoreMatcher(repositoryPath: string): TutorIgnoreMatcher {
  ensureTutorIgnore(repositoryPath);
  const rules = readTutorIgnore(repositoryPath).flatMap(parseRule);
  const ignored = (relativePath: string, isDirectory = false): boolean => {
    const normalized = normalize(relativePath);
    if (!normalized) return true;
    const candidates = candidatesFor(normalized, isDirectory);
    let result = false;
    for (const rule of rules) {
      if (candidates.some((candidate) => matches(rule, candidate))) result = !rule.negate;
    }
    return result;
  };
  return {
    ignores: ignored,
    shouldTraverse(relativeDirectory: string): boolean {
      const normalized = normalize(relativeDirectory);
      if (!normalized) return false;
      if (!ignored(normalized, true)) return true;
      return rules.some((rule) => rule.negate && canMatchDescendant(rule, normalized));
    }
  };
}

export function isTutorIgnoreFile(relativePath: string): boolean {
  return normalize(relativePath) === configName;
}

export function ensureTutorIgnore(repositoryPath: string): void {
  const path = join(repositoryPath, configName);
  if (existsSync(path)) return;
  try {
    writeFileSync(path, defaultTutorIgnoreContents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

function readTutorIgnore(repositoryPath: string): string[] {
  const path = join(repositoryPath, configName);
  if (!existsSync(path)) return [];
  try { return readFileSync(path, "utf8").split(/\r?\n/); } catch { return []; }
}

function parseRule(line: string): IgnoreRule[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return [];
  const negate = trimmed.startsWith("!");
  const raw = (negate ? trimmed.slice(1) : trimmed).replaceAll("\\", "/");
  if (!raw || raw === "/") return [];
  const anchored = raw.startsWith("/");
  const directoryOnly = raw.endsWith("/");
  const pattern = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!pattern) return [];
  const basenameOnly = !pattern.includes("/");
  return [{ raw: pattern, negate, directoryOnly, basenameOnly, anchored, expression: globExpression(pattern, basenameOnly, anchored), staticPrefix: pattern.split(/[?*]/)[0].replace(/\/$/, "") }];
}

function globExpression(pattern: string, basenameOnly: boolean, anchored: boolean): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      while (pattern[index + 1] === "*") index += 1;
      if (pattern[index + 1] === "/") {
        expression += "(?:.*/)?";
        index += 1;
      } else expression += ".*";
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  if (basenameOnly) return new RegExp(`^${expression}$`);
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${expression}$`);
}

function candidatesFor(path: string, isDirectory: boolean): string[] {
  const segments = path.split("/");
  const candidates: string[] = [];
  for (let index = 1; index < segments.length; index += 1) candidates.push(segments.slice(0, index).join("/"));
  if (isDirectory || segments.length) candidates.push(path);
  return [...new Set(candidates)];
}

function matches(rule: IgnoreRule, candidate: string): boolean {
  if (rule.directoryOnly && !candidate) return false;
  if (rule.basenameOnly && rule.anchored && candidate.includes("/")) return false;
  return rule.expression.test(rule.basenameOnly ? candidate.split("/").at(-1) ?? "" : candidate);
}

function canMatchDescendant(rule: IgnoreRule, directory: string): boolean {
  if (rule.basenameOnly || !rule.staticPrefix) return true;
  return rule.staticPrefix === directory || rule.staticPrefix.startsWith(`${directory}/`) || directory.startsWith(`${rule.staticPrefix}/`);
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}
