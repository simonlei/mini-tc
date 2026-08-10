#!/bin/bash
#=============================================================
# Mini TC - 构建与运行脚本 (Git Bash / 跨机器通用)
# 用法:
#   ./dev.sh           # 开发模式 (热更新, 自动打开窗口)
#   ./dev.sh dev       # 同上
#   ./dev.sh build     # 构建发布版本 (生成 .exe)
#   ./dev.sh check     # 仅检查 Rust 编译 (不产出二进制)
#   ./dev.sh clean     # 清理构建产物
#=============================================================

set -euo pipefail

# Rust 1.97.1 ICE 规避：禁用增量编译
export CARGO_INCREMENTAL=0

# ---- 路径常量（基于脚本所在目录，跨机器通用，无需硬编码项目路径） ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}"
SRC_TAURI="${PROJECT_ROOT}/src-tauri"

# ---- Node.js 自动探测（不依赖 PATH 中是否已配置；本机未把
#      ~/.workbuddy/binaries/node/versions/22.22.2/ 加进 PATH 也能跑） ----
detect_node() {
  # 1) 已在 PATH 上
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(dirname "$(command -v node)")"
    return 0
  fi
  # 2) 常见安装位置（Git Bash 下用 /c/... 形式）
  local dir
  for dir in \
    "/c/Program Files/nodejs" \
    "/c/Program Files (x86)/nodejs" \
    "$LOCALAPPDATA/fnm_multishells"/* \
    "$HOME/.fnm"/* \
    "$HOME/.nvm/versions/node"/* ; do
    if [ -x "${dir}/node.exe" ]; then NODE_BIN="$dir"; return 0; fi
  done
  # 3) WorkBuddy 管理的 Node：~/.workbuddy/binaries/node/versions/<ver>/node.exe
  for dir in "$HOME/.workbuddy/binaries/node/versions"/*; do
    if [ -x "${dir}/node.exe" ]; then NODE_BIN="$dir"; return 0; fi
  done
  return 1
}

if detect_node; then
  echo ">> 使用 Node.js: ${NODE_BIN}"
  export PATH="${NODE_BIN}:$PATH"
else
  echo "[ERROR] 未找到 Node.js。请安装 Node.js 或将其加入 PATH。" >&2
  exit 1
fi

# ---- MSVC 工具链自动探测（扫描 VS 安装，避免硬编码版本号） ----
MSVC_BASE=""          # Git Bash 风格: /c/...
MSVC_WIN=""           # Windows 风格: C:\... (用于 INCLUDE/LIB)
SDK_BASE="/c/Program Files (x86)/Windows Kits/10"
SDK_WIN="C:\\Program Files (x86)\\Windows Kits\\10"
MSVC_VER=""
SDK_VER=""

detect_msvc() {
  local vsroot vsroot_win
  for vsroot in \
    "/c/Program Files/Microsoft Visual Studio/2022/Community" \
    "/c/Program Files/Microsoft Visual Studio/2022/Professional" \
    "/c/Program Files/Microsoft Visual Studio/2022/Enterprise" \
    "/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools" \
    "/c/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools" \
    "/c/Program Files (x86)/Microsoft Visual Studio/2019/Community" ; do
    if [ -d "$vsroot/VC/Tools/MSVC" ]; then
      MSVC_VER="$(ls -r "$vsroot/VC/Tools/MSVC" 2>/dev/null | grep -E '^[0-9]' | head -1)"
      if [ -n "$MSVC_VER" ]; then
        MSVC_BASE="$vsroot/VC/Tools/MSVC/$MSVC_VER"
        vsroot_win="${vsroot/#\/c\//C:}"
        vsroot_win="${vsroot_win//\//\\}"
        MSVC_WIN="${vsroot_win}\\VC\\Tools\\MSVC\\${MSVC_VER}"
        break
      fi
    fi
  done
  if [ -d "$SDK_BASE/Include" ]; then
    SDK_VER="$(ls -r "$SDK_BASE/Include" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)"
  fi
}

# ---- 设置 MSVC 环境变量 ----
setup_msvc() {
  if [ -z "$MSVC_BASE" ] || [ -z "$MSVC_VER" ]; then
    echo "[WARN] 未找到 MSVC 工具链，依赖系统 rustup 默认工具链..."
    return 0
  fi
  echo ">> 设置 MSVC 编译环境 (MSVC ${MSVC_VER}, SDK ${SDK_VER})..."
  export PATH="${MSVC_BASE}/bin/Hostx64/x64:${SDK_BASE}/bin/${SDK_VER}/x64:${SDK_BASE}/bin/x64:$PATH"
  export INCLUDE="${MSVC_WIN}\\include;${SDK_WIN}\\Include\\${SDK_VER}\\shared;${SDK_WIN}\\Include\\${SDK_VER}\\ucrt;${SDK_WIN}\\Include\\${SDK_VER}\\um;${SDK_WIN}\\Include\\${SDK_VER}\\winrt;${SDK_WIN}\\Include\\${SDK_VER}\\cppwinrt"
  export LIB="${MSVC_WIN}\\lib\\x64;${SDK_WIN}\\Lib\\${SDK_VER}\\um\\x64;${SDK_WIN}\\Lib\\${SDK_VER}\\ucrt\\x64"
}

# ---- 确保 npm 依赖已安装（本地 tauri CLI 可用） ----
ensure_deps() {
  if [ -x "${PROJECT_ROOT}/node_modules/.bin/tauri" ]; then
    return 0
  fi
  echo "[1/3] 安装 npm 依赖 (本地 tauri CLI 缺失)..."
  npm install
}

# ---- 各操作 ----
run_dev() {
  echo ">> 启动开发模式 (Vite + Tauri 热更新)..."
  cd "${PROJECT_ROOT}"
  setup_msvc
  ensure_deps
  npm run tauri dev
}

run_build() {
  echo ">> 构建发布版本..."
  cd "${PROJECT_ROOT}"
  setup_msvc
  ensure_deps
  npm run tauri build
  echo ""
  echo ">> 构建完成! 产物位置:"
  echo "   exe: ${SRC_TAURI}/target/release/mini-tc.exe"
  echo "   安装包: ${SRC_TAURI}/target/release/bundle/"
}

run_check() {
  echo ">> 检查 Rust 编译..."
  cd "${SRC_TAURI}"
  setup_msvc
  cargo check 2>&1
  echo ">> 检查通过"
}

run_clean() {
  echo ">> 清理构建产物..."
  cd "${SRC_TAURI}"
  cargo clean
  rm -rf "${PROJECT_ROOT}/dist"
  echo ">> 清理完成"
}

# ---- 主入口 ----
detect_msvc
CMD="${1:-dev}"
case "$CMD" in
  dev)   run_dev ;;
  build) run_build ;;
  check) run_check ;;
  clean) run_clean ;;
  *)
    echo "用法: $0 [dev|build|check|clean]"
    echo "  dev   - 开发模式 (默认)"
    echo "  build - 构建发布版本"
    echo "  check - 仅检查 Rust 编译"
    echo "  clean - 清理构建产物"
    exit 1
    ;;
esac
