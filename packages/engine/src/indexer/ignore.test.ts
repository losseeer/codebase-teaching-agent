import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexRepository } from "./indexer.js";
import { createTutorIgnoreMatcher } from "./ignore.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe(".tutorignore", () => {
  it("excludes default Agent workspaces and generated directories from indexing", () => {
    const repository = fixture({
      "src/main.ts": "export const main = true;",
      ".claude/session.json": "{}",
      ".workbuddy/notes.md": "work notes",
      "node_modules/package/index.js": "module.exports = {};",
      "dist/bundle.js": "console.log('built');"
    });
    expect(indexRepository(repository).files.map((file) => file.path)).toEqual(["src/main.ts"]);
  });

  it("applies root patterns, globs and later explicit re-inclusion", () => {
    const repository = fixture({
      ".tutorignore": "# generated files\ngenerated/\ndocs/*.md\n!docs/keep.md\n/*.local.ts\nsamples/**/*.json\n",
      "generated/output.ts": "export const output = true;",
      "docs/skip.md": "skip",
      "docs/keep.md": "keep",
      "nested/docs/skip.md": "nested skip",
      "config.local.ts": "export const local = true;",
      "nested/config.local.ts": "export const nested = true;",
      "samples/root.json": "{}",
      "samples/nested/example.json": "{}",
      "src/main.ts": "export const main = true;"
    });
    expect(indexRepository(repository).files.map((file) => file.path)).toEqual(["docs/keep.md", "nested/config.local.ts", "src/main.ts"]);
  });

  it("materializes defaults in .tutorignore and subsequently uses only that file", () => {
    const repository = fixture({ ".claude/settings.json": "{}", ".tutor/state.json": "{}" });
    const matcher = createTutorIgnoreMatcher(repository);
    expect(existsSync(join(repository, ".tutorignore"))).toBe(true);
    expect(readFileSync(join(repository, ".tutorignore"), "utf8")).toContain(".workbuddy/");
    expect(matcher.ignores(".claude/settings.json")).toBe(true);
    expect(matcher.ignores(".tutor/state.json")).toBe(true);
    writeFileSync(join(repository, ".tutorignore"), "!.claude/**\n!.tutor/**\n", "utf8");
    const customized = createTutorIgnoreMatcher(repository);
    expect(customized.ignores(".claude/settings.json")).toBe(false);
    expect(customized.ignores(".tutor/state.json")).toBe(false);
    expect(indexRepository(repository).files.map((file) => file.path)).toEqual([".claude/settings.json", ".tutor/state.json"]);
  });
  it("keeps git hotspots within the same exclusion rules as indexing", () => {
    const repository = fixture({ "src/main.ts": "export const main = true;" });
    mkdirSync(join(repository, "dist"), { recursive: true });
    writeFileSync(join(repository, "dist/bundle.js"), "console.log('bundled');", "utf8");
    const commit = (...args: string[]): void => { execFileSync("git", ["-C", repository, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" }); };
    commit("init");
    commit("add", "-A");
    commit("commit", "-m", "init");
    for (let index = 0; index < 3; index += 1) {
      writeFileSync(join(repository, "dist/bundle.js"), `console.log('bundled v${index}');`, "utf8");
      commit("add", "-A");
      commit("commit", "-m", `churn ${index}`);
    }
    const index = indexRepository(repository);
    expect(index.files.map((file) => file.path)).toEqual(["src/main.ts"]);
    expect(index.hotspots.map((hotspot) => hotspot.path)).toEqual(["src/main.ts"]);
  });
});

function fixture(files: Record<string, string>): string {
  const repository = join(tmpdir(), `codebase-tutor-ignore-${Date.now()}-${directories.length}`);
  directories.push(repository);
  for (const [path, content] of Object.entries(files)) {
    const file = join(repository, path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  return repository;
}
