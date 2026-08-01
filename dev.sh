#!/bin/bash
#=============================================================
# Mini TC - 构建与运行脚本
# 用法:
#   ./dev.sh           # 开发模式 (热更新, 自动打开窗口)
#   ./dev.sh dev       # 同上
#   ./dev.sh build     # 构建发布版本 (生成 .exe + .msi)
#   ./dev.sh check     # 仅检查 Rust 编译 (不产出二进制)
#   ./dev.sh clean     # 清理构建产物
#=============================================================

set -euo pipefail

# Workaround for rustc 1.97.1 ICE (rmeta encoder panic) — disable incremental compilation
export CARGO_INCREMENTAL=0

# ---- 路径常量 ----
PROJECT_ROOT="C:/Users/simon/WorkBuddy/mini-tc"
SRC_TAURI="${PROJECT_ROOT}/src-tauri"

# ---- MSVC 工具链配置 ----
MSVC_VER="14.44.35207"
SDK_VER="10.0.26100.0"
MSVC_BASE="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/${MSVC_VER}"
SDK_BASE="/c/Program Files (x86)/Windows Kits/10"
MSVC_WIN="C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\${MSVC_VER}"
SDK_WIN="C:\\Program Files (x86)\\Windows Kits\\10"

# ---- 设置 MSVC 环境变量 ----
setup_msvc() {
  echo ">> 设置 MSVC 编译环境..."
  export PATH="${MSVC_BASE}/bin/Hostx64/x64:${SDK_BASE}/bin/${SDK_VER}/x64:${SDK_BASE}/bin/x64:$PATH"
  export INCLUDE="${MSVC_WIN}\\include;${SDK_WIN}\\Include\\${SDK_VER}\\shared;${SDK_WIN}\\Include\\${SDK_VER}\\ucrt;${SDK_WIN}\\Include\\${SDK_VER}\\um;${SDK_WIN}\\Include\\${SDK_VER}\\winrt;${SDK_WIN}\\Include\\${SDK_VER}\\cppwinrt"
  export LIB="${MSVC_WIN}\\lib\\x64;${SDK_WIN}\\Lib\\${SDK_VER}\\um\\x64;${SDK_WIN}\\Lib\\${SDK_VER}\\ucrt\\x64"
}

# ---- 各操作 ----
run_dev() {
  echo ">> 启动开发模式 (Vite + Tauri 热更新)..."
  cd "${PROJECT_ROOT}"
  setup_msvc
  npx tauri dev
}

run_build() {
  echo ">> 构建发布版本..."
  cd "${PROJECT_ROOT}"
  setup_msvc
  # tauri build 会自动先跑 npm run build (beforeBuildCommand), 再 cargo build --release
  npx tauri build
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
