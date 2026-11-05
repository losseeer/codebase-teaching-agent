#!/usr/bin/env bash
# 在**用户自己的终端**里跑 design-followup-2026-11 消融（付费、串行、约数小时）。
#
# 为什么必须开终端：WorkBuddy 会话内的进程继承 macOS Seatbelt，产品的
# `sandbox-exec -p '(deny ...)'` 会报 `sandbox_apply: Operation not permitted`，
# 隔离探测 fail-closed 后代码题整域禁用；Terminal 自动化与 launchctl 也被权限挡住。
# 只有不经会话派生的终端进程能让隔离探测拿到 `enforced`。
#
# 用法：
#   ./run.sh --dry                 # 只校验冻结数据集，不花钱
#   ./run.sh --pairs=1 --out=experiments/design-followup-2026-11/smoke.jsonl
#   ./run.sh                       # 全量 30 对 × 2 臂
#   ./run.sh --from=12             # 从第 12 对续跑（结果文件已有内容时必须用）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATASET="$ROOT/experiments/design-followup-2026-11"
LOG="$DATASET/run.log"
mkdir -p "$DATASET"
export TUTOR_LLM_LOG="$DATASET/llm.log"
# better-sqlite3 由 brew node 26.3.0 编译；固定 PATH，避免从注入了其它 node 的终端启动时 ABI 不匹配。
export PATH="/opt/homebrew/bin:$PATH"
cd "$ROOT/packages/engine"

echo "[design-followup] $(date -u +%FT%TZ) args: $*" | tee -a "$LOG"
set +e
/opt/homebrew/bin/pnpm exec tsx dev/experiment/design-followup.ts "$@" 2>&1 | tee -a "$LOG"
code="${PIPESTATUS[0]}"
set -e
echo "[design-followup] $(date -u +%FT%TZ) exit=$code" | tee -a "$LOG"
exit "$code"
