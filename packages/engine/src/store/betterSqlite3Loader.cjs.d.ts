/**
 * Native binding loader for better-sqlite3.
 *
 * Scans `packages/engine/native/` for ABI-specific prebuild binaries
 * (`better_sqlite3.node.v{modules}`) and dlopens the one matching the current
 * Node ABI. Falls back to the default binary or the pnpm-managed binding when
 * the engine-native directory is absent.
 *
 * 背景：better-sqlite3 12.x 不是 N-API binding，每个 Node ABI（127/147）单独 binary。
 * 若 `pnpm install` 时与 `pnpm exec tsx` 时使用的 Node 不同，会触发
 * `NODE_MODULE_VERSION 127 vs 147` 错。
 */
export function resolveBindingPath(): string | null;
export function loadAddon(): unknown;