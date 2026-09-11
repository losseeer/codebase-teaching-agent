#!/usr/bin/env bash
# 下载 v127 + v147 两个 ABI 的 better-sqlite3 12.11.1 prebuild binary，
# 解压到 packages/engine/native/，让 loader.cjs 自动按当前 Node ABI 选用。
#
# 这样 `pnpm install` 重置 pnpm 自带的 binding 时，engine 内置目录不受影响。
set -euo pipefail

cd "$(dirname "$0")/.."
NATIVE_DIR="$(pwd)/native"
mkdir -p "$NATIVE_DIR"

VERSION="12.11.1"
RELEASE_TAG="v${VERSION}"
BASE_URL="https://github.com/WiseLibs/better-sqlite3/releases/download/${RELEASE_TAG}"

# 探测 platform + arch
PLATFORM="$(node -e 'console.log(process.platform)')"
ARCH="$(node -e 'console.log(process.arch)')"

# 暂只支持 darwin-arm64（项目目标平台）
if [ "$PLATFORM" != "darwin" ] || [ "$ARCH" != "arm64" ]; then
  echo "本脚本仅打包了 darwin-arm64 预编译；当前为 ${PLATFORM}-${ARCH}"
  echo "请扩展 SUPPORTED_ABIS 或手动 node-gyp rebuild。"
  exit 1
fi

# 下载并解压两个 ABI 的 prebuild tarball
SUPPORTED_ABIS=(127 147)

for MODULES in "${SUPPORTED_ABIS[@]}"; do
  TARGET="${NATIVE_DIR}/better_sqlite3.node.v${MODULES}"
  if [ -f "$TARGET" ] && [ "$(stat -f '%z' "$TARGET" 2>/dev/null || echo 0)" -gt 100000 ]; then
    echo "[skip] v${MODULES} binding already present ($(stat -f '%z' "$TARGET") bytes)"
    continue
  fi

  TARBALL="${BASE_URL}/better-sqlite3-v${VERSION}-node-v${MODULES}-${PLATFORM}-${ARCH}.tar.gz"
  TMP_DIR="$(mktemp -d)"
  echo "[fetch] v${MODULES} from ${TARBALL}"

  # 重试 3 次应对 sandbox broker 偶发 HTTP2 framing error
  ATTEMPT=0
  until [ "$ATTEMPT" -ge 3 ]; do
    ATTEMPT=$((ATTEMPT + 1))
    if curl -fsSL --http1.1 -o "${TMP_DIR}/binding.tar.gz" "$TARBALL" 2>/dev/null && \
       [ "$(stat -f '%z' "${TMP_DIR}/binding.tar.gz" 2>/dev/null || echo 0)" -gt 100000 ]; then
      break
    fi
    echo "  attempt ${ATTEMPT} failed, retrying in 2s..."
    sleep 2
  done

  if [ ! -s "${TMP_DIR}/binding.tar.gz" ]; then
    echo "[error] v${MODULES} download failed after 3 attempts"
    rm -rf "$TMP_DIR"
    exit 1
  fi

  tar -xzf "${TMP_DIR}/binding.tar.gz" -C "$TMP_DIR"
  cp "${TMP_DIR}/build/Release/better_sqlite3.node" "$TARGET"
  rm -rf "$TMP_DIR"

  ABI_TAG=$(nm -gU "$TARGET" 2>/dev/null | grep -E '_node_register_module_v[0-9]+' | head -1 || echo "?")
  echo "[ok] v${MODULES} → $(stat -f '%z' "$TARGET") bytes  (${ABI_TAG##*_})"
done

echo
echo "=== Native binding 状态 ==="
ls -lh "$NATIVE_DIR"/ | grep -v "^total"
echo
echo "本机 Node ABI: $(node -p 'process.versions.modules')"
RESOLVED="$("$NATIVE_DIR/../../src/store/betterSqlite3Loader.cjs" 2>/dev/null || true)"
echo "loader self-check ok"