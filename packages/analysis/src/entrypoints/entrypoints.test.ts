import { describe, expect, it } from "vitest";
import type { FileEntry } from "@codebase-tutor/domain";

import { detectEntrypoints } from "./entrypoints.js";

const file = (path: string): FileEntry => ({ path, extension: ".go", bytes: 0, lines: 0 });

describe("Go 入口判定", () => {
  it("注释里的 func main 不算入口，真实 main 算", () => {
    const doc = detectEntrypoints("/tmp/repo", [file("doc.go")], new Map([["doc.go", "// func main() {}\n/* func main() {} */\npackage gin\n"]]));
    expect(doc).toEqual([]);

    const main = detectEntrypoints("/tmp/repo", [file("main.go")], new Map([["main.go", "package main\nfunc main() {}\n"]]));
    expect(main.map((anchor) => anchor.path)).toEqual(["main.go"]);
  });
});
