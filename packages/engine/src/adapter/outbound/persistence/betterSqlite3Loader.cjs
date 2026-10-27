#!/usr/bin/env node
/**
 * 加载与当前 Node.js ABI 匹配的 better-sqlite3 binding。
 *
 * 背景：better-sqlite3 12.x 不是 N-API binding，每个 Node ABI（127/147）单独 binary。
 * 若 `pnpm install` 时与 `pnpm exec tsx` 时使用的 Node 不同，会触发
 * `NODE_MODULE_VERSION 127 vs 147` 错。
 *
 * 本模块绕过 better-sqlite3 自身的 `bindings` 包（其搜索路径 hardcode `bindings.node`，
 * 不支持多 ABI），直接从 engine/native/ 或 pnpm build/Release/ 扫描多 ABI binary，
 * 用 process.dlopen() 加载（避免 WorkBuddy 的 node-language-shim 干扰 .node require）。
 *
 * 调用方将返回的 addon 直接传给 `new Database(filename, { nativeBinding })`，
 * 不污染 better-sqlite3 本身的代码（pnpm install 不会覆盖）。
 */
"use strict";
const { existsSync, readFileSync } = require("node:fs");
const { join, dirname } = require("node:path");

const NATIVE_DIR_KEY = Symbol.for("codebase-tutor.native-binding-dir");
/**
 * native/ 在引擎包根。往上按 package.json 的包名找那一层，不写死层数——
 * 写死的层数一搬家就静默指到别处，候选 2（pnpm 装的那份）会替它圆场，ABI 不匹配的日子就过下去了。
 * 找不到就返回 null，让候选 2 明着接管。
 */
function nativeDir() {
  if (globalThis[NATIVE_DIR_KEY] === undefined) {
    let directory = __dirname;
    let found = null;
    for (let up = 0; up < 8 && !found; up += 1) {
      try {
        if (/"name":\s*"@codebase-tutor\/engine"/.test(readFileSync(join(directory, "package.json"), "utf8"))) found = join(directory, "native");
      } catch {
        // 这一层没有 package.json，继续往上就是正常路径
      }
      directory = dirname(directory);
    }
    globalThis[NATIVE_DIR_KEY] = found;
  }
  return globalThis[NATIVE_DIR_KEY];
}

/**
 * 直接 dlopen .node 文件，返回 addon.exports。
 * 失败时返回 null（区别于 throw，让 loader 链回退到下一个候选路径）。
 */
function tryDlopen(absPath) {
  if (!existsSync(absPath)) return null;
  const mod = { exports: {} };
  try {
    process.dlopen(mod, absPath);
    return mod.exports;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/NODE_MODULE_VERSION/.test(msg)) return null; // ABI 不匹配
    if (e && e.code === "ERR_DLOPEN_FAILED") return null; // wrong platform/corrupt native binary; try next candidate
    throw e;
  }
}

/**
 * 按优先顺序扫描候选路径，返回第一个 dlopen 成功的 binary 路径。
 * @returns {string|null}
 */
function resolveBindingPath() {
  const modules = process.versions.modules;
  const wantName = `better_sqlite3.node.v${modules}`;
  const fallback = "better_sqlite3.node";

  // 1. engine 自带 native/（推荐，pnpm install 不覆盖）
  const engineDir = nativeDir();
  const enginePath = !engineDir
    ? null
    : existsSync(join(engineDir, wantName))
      ? join(engineDir, wantName)
      : existsSync(join(engineDir, fallback)) ? join(engineDir, fallback) : null;
  if (enginePath && tryDlopen(enginePath)) return enginePath;

  // 2. 回退：pnpm 安装的 better-sqlite3 build/Release
  try {
    const pnpmPath = require.resolve("better-sqlite3/package.json");
    const pnpmReleaseDir = join(dirname(pnpmPath), "build", "Release");
    if (existsSync(join(pnpmReleaseDir, wantName))) return join(pnpmReleaseDir, wantName);
    if (existsSync(join(pnpmReleaseDir, fallback))) return join(pnpmReleaseDir, fallback);
  } catch {
    /* better-sqlite3 未安装（极端情况） */
  }

  return null;
}

/**
 * 加载 addon 并注入 SqliteError 构造函数（与 better-sqlite3/lib/database.js 一致）。
 * @returns {object} addon exports
 */
function loadAddon() {
  const absPath = resolveBindingPath();
  if (!absPath) {
    throw new Error(
      `未找到与 Node ABI ${process.versions.modules} 匹配的 better-sqlite3 binding。\n` +
        `请运行：pnpm --filter @codebase-tutor/engine run setup:native`
    );
  }
  const addon = tryDlopen(absPath);
  if (!addon) {
    throw new Error(
      `better-sqlite3 binding @ ${absPath} 不匹配 Node ABI ${process.versions.modules}。\n` +
        `请运行：pnpm --filter @codebase-tutor/engine run setup:native`
    );
  }
  if (!addon.isInitialized) {
    addon.setErrorConstructor(require("better-sqlite3/lib/sqlite-error"));
    addon.isInitialized = true;
  }
  return addon;
}

module.exports = { loadAddon };
