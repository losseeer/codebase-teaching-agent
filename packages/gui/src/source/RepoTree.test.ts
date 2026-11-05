/** [DEV ONLY] 文件树的「单一子目录」折叠规则。 */
import { describe, expect, it } from "vitest";
import type { FileTreeNode } from "@codebase-tutor/domain";

import { foldSingleChildDirs } from "./RepoTree.js";

const dir = (name: string, path: string, children?: FileTreeNode[]): FileTreeNode =>
  ({ name, path, kind: "directory", ...(children ? { children } : {}) });
const file = (name: string, path: string): FileTreeNode => ({ name, path, kind: "file" });

describe("foldSingleChildDirs", () => {
  it("目录下只有一个子目录时合成一行 src/main", () => {
    const [node] = foldSingleChildDirs([dir("src", "src", [dir("main", "src/main", [file("a.ts", "src/main/a.ts")])])]);
    expect(node!.name).toBe("src/main");
    expect(node!.path, "身份取子目录，点它能选到真实路径").toBe("src/main");
    expect(node!.children?.map((child) => child.name)).toEqual(["a.ts"]);
  });

  it("有多个子目录就不折叠", () => {
    const [node] = foldSingleChildDirs([dir("src", "src", [dir("main", "src/main"), dir("test", "src/test")])]);
    expect(node!.name).toBe("src");
    expect(node!.children).toHaveLength(2);
  });

  it("只有一个文件时也不折叠", () => {
    const [node] = foldSingleChildDirs([dir("src", "src", [file("a.ts", "src/a.ts")])]);
    expect(node!.name).toBe("src");
    expect(node!.children).toHaveLength(1);
  });

  it("逐层折叠：a → b → c 合成 a/b/c", () => {
    const [node] = foldSingleChildDirs([dir("a", "a", [dir("b", "a/b", [dir("c", "a/b/c", [file("x.ts", "a/b/c/x.ts")])])])]);
    expect(node!.name).toBe("a/b/c");
    expect(node!.path).toBe("a/b/c");
  });

  it("文件节点原样不动", () => {
    const [node] = foldSingleChildDirs([file("a.ts", "a.ts")]);
    expect(node).toEqual(file("a.ts", "a.ts"));
  });
});
