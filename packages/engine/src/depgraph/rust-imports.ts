import { dirname, join, normalize } from "node:path";
import { slash } from "./repo-paths.js";

/**
 * Rust 的仓内依赖两种：`mod x;`（声明子模块，对应 x.rs 或 x/mod.rs）与 `use crate::a::b;`。
 * `use x::{c, d}` 取路径前缀即可；外部 crate（`use serde::…`）不经 crate/self/super 打头，天然不落点。
 */
export function extractRustSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const modMatch = trimmed.match(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/);
    if (modMatch) specifiers.push(`mod:${modMatch[1]}`);
    const useMatch = trimmed.match(/^use\s+(crate|self|super)::([\w:]+)/);
    if (useMatch) specifiers.push(`use:${useMatch[1]}:${useMatch[2]}`);
  }
  return specifiers;
}

export function resolveRustImport(from: string, specifier: string, available: Set<string>): string | undefined {
  const dir = dirname(from);
  if (specifier.startsWith("mod:")) {
    const name = specifier.slice(4);
    return [slash(join(dir, `${name}.rs`)), slash(join(dir, name, "mod.rs"))].find((candidate) => available.has(candidate));
  }
  const rest = specifier.slice(4); // `crate:a::b`
  const originEnd = rest.indexOf(":");
  const origin = rest.slice(0, originEnd);
  const chain = rest.slice(originEnd + 1).replace(/:$/, "").replaceAll("::", "/");
  const base = origin === "crate" ? "src" : origin === "self" ? dir : dirname(dir);
  let current = slash(normalize(join(base, chain)));
  for (;;) {
    const hit = [`${current}.rs`, `${current}/mod.rs`].find((candidate) => available.has(candidate));
    if (hit) return hit;
    const cut = current.lastIndexOf("/");
    if (cut <= 0) return undefined;
    current = current.slice(0, cut);
  }
}
