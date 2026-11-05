#!/usr/bin/env bash
# 在**用户自己的终端**里跑 defect2-tool-budget-2026-11 消融（付费、串行、数小时）。
# 一条命令完成：冒烟 3 对 → gate 判定 → 通过才继续跑剩余 27 对（合计 30 对）。
# 会话内进程继承 Seatbelt，产品的隔离探测会 fail-closed，所以必须从终端启动。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATASET="$ROOT/experiments/defect2-tool-budget-2026-11"
LOG="$DATASET/run.log"
mkdir -p "$DATASET"
export TUTOR_LLM_LOG="$DATASET/llm.log"
# better-sqlite3 由 brew node 26.3.0 编译；固定 PATH 避免 ABI 不匹配。
export PATH="/opt/homebrew/bin:$PATH"
cd "$ROOT/packages/engine"

echo "[defect2] $(date -u +%FT%TZ) args: $*" | tee -a "$LOG"
set +e
/opt/homebrew/bin/pnpm exec tsx dev/experiment/defect2-tool-budget.ts "$@" 2>&1 | tee -a "$LOG"
code="${PIPESTATUS[0]}"
set -e
echo "[defect2] $(date -u +%FT%TZ) exit=$code" | tee -a "$LOG"
exit "$code"
