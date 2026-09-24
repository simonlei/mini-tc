#!/bin/bash
#=============================================================
# Mini TC - Windows 原生版 (.NET 8 / WPF) 构建与运行脚本
# (Git Bash / 跨机器通用，类似根目录 dev.sh)
# 用法:
#   ./native-dev.sh           # 开发模式 (编译并启动 GUI)
#   ./native-dev.sh dev       # 同上
#   ./native-dev.sh build     # 构建 Release 版本 (生成 .exe)
#   ./native-dev.sh check     # 仅编译检查 (不启动、不跑测试)
#   ./native-dev.sh test      # 运行 48 个契约测试
#   ./native-dev.sh clean     # 清理构建产物
#=============================================================

set -euo pipefail

# ---- 路径常量（基于脚本所在目录，跨机器通用） ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}"
WIN_NATIVE="${PROJECT_ROOT}/win-native"

# ---- .NET SDK 自动探测（不依赖 PATH 中是否已配置；文档记录
#      本机 dotnet 不在 PATH，故需要扫描常见安装位置） ----
detect_dotnet() {
  # 1) 已在 PATH 上
  if command -v dotnet >/dev/null 2>&1; then
    DOTNET_BIN="$(dirname "$(command -v dotnet)")"
    return 0
  fi
  # 2) 常见安装位置（Git Bash 下用 /c/... 形式）
  local dir
  for dir in \
    "/c/Program Files/dotnet" \
    "/c/Program Files (x86)/dotnet" \
    "$HOME/.dotnet" ; do
    if [ -x "${dir}/dotnet.exe" ]; then DOTNET_BIN="$dir"; return 0; fi
  done
  # 3) dotnet-install.sh 可能装到 ~/.dotnet 的带版本子目录
  for dir in "$HOME/.dotnet"/*; do
    if [ -x "${dir}/dotnet.exe" ]; then DOTNET_BIN="$dir"; return 0; fi
  done
  return 1
}

if detect_dotnet; then
  echo ">> 使用 .NET SDK: ${DOTNET_BIN}"
  export PATH="${DOTNET_BIN}:$PATH"
else
  echo "[ERROR] 未找到 .NET SDK。请安装 .NET 8 SDK 或将其加入 PATH。" >&2
  echo "   下载: https://dotnet.microsoft.com/download/dotnet/8.0" >&2
  exit 1
fi

# ---- 各操作 ----

# 开发模式：编译并启动 GUI（等价 dev.sh 的 tauri dev）。
# 需要热重载可用 `dotnet watch --project src/MiniTC run` 替代。
run_dev() {
  echo ">> 启动 Windows 原生版 (编译 + 运行)..."
  cd "${WIN_NATIVE}"
  dotnet run --project src/MiniTC
}

# Release 构建
run_build() {
  echo ">> 构建 Release 版本..."
  cd "${WIN_NATIVE}"
  dotnet build -c Release
  echo ""
  echo ">> 构建完成! 产物位置:"
  echo "   exe: ${WIN_NATIVE}/src/MiniTC/bin/Release/net8.0-windows/MiniTC.exe"
}

# 仅编译检查（不启动、不跑测试）
run_check() {
  echo ">> 编译检查 (Debug)..."
  cd "${WIN_NATIVE}"
  dotnet build
  echo ">> 编译通过"
}

# 运行契约测试 (48 个)
run_test() {
  echo ">> 运行契约测试..."
  cd "${WIN_NATIVE}"
  dotnet test tests/MiniTC.Tests
}

# 清理构建产物 (bin/ obj/ artifacts/ 均在 .gitignore 内)
run_clean() {
  echo ">> 清理构建产物..."
  cd "${WIN_NATIVE}"
  dotnet clean >/dev/null 2>&1 || true
  rm -rf \
    "${WIN_NATIVE}/src/MiniTC/bin" \
    "${WIN_NATIVE}/src/MiniTC/obj" \
    "${WIN_NATIVE}/tests/MiniTC.Tests/bin" \
    "${WIN_NATIVE}/tests/MiniTC.Tests/obj" \
    "${WIN_NATIVE}/artifacts" \
    "${WIN_NATIVE}/publish-test"
  echo ">> 清理完成"
}

# ---- 主入口 ----
CMD="${1:-dev}"
case "$CMD" in
  dev)   run_dev ;;
  build) run_build ;;
  check) run_check ;;
  test)  run_test ;;
  clean) run_clean ;;
  *)
    echo "用法: $0 [dev|build|check|test|clean]"
    echo "  dev   - 开发模式: 编译并启动 GUI (默认)"
    echo "  build - 构建 Release 版本"
    echo "  check - 仅编译检查"
    echo "  test  - 运行契约测试"
    echo "  clean - 清理构建产物"
    exit 1
    ;;
esac
