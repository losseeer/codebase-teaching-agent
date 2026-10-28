/**
 * 按当前 Node ABI 加载 better-sqlite3 的原生 binding：优先 `packages/engine/native/` 下的
 * `better_sqlite3.node.v{modules}`，缺失时回退默认 binary 或 pnpm 管理的 binding。
 */
export function loadAddon(): unknown;