#!/bin/bash
#=============================================================
# Mini TC - 构建与运行脚本 (Git Bash / 跨机器通用)
# 用法:
#   ./dev.sh           # 开发模式 (热更新, 自动打开窗口)
#   ./dev.sh dev       # 同上
#   ./dev.sh build     # 构建发布版本 (生成 .exe)
#   ./dev.sh check     # 仅检查 Rust 编译 (不产出二进制)
#   ./dev.sh clean     # 清理构建产物
#   ./dev.sh deps      # 强制执行 npm install
#
# 每个阶段都会打印耗时（ms），格式:
#   [标签] 1234 ms
#=============================================================

set -euo pipefail

# ---- 分步计时 ----
# 统一毫秒输出，和 scripts/deps-hash.js 里 npm install 的计时口径一致。
now_ms() {
  local n
  n="$(date +%s%N 2>/dev/null)" || n=""
  case "$n" in
    ""|*N*) echo "" ;;              # date 不支持 %N（非 GNU coreutils）→ 关闭计时
    *)     echo $(( n / 1000000 )) ;;
  esac
}

# step "<标签>" <命令...>  —— 跑完打印该步耗时（ms）
# 用 `|| rc=$?` 而不是裸调，否则 set -e 会在命令失败的那一刻直接退掉，
# 计时行永远打不出来。
step() {
  local label="$1"; shift
  local t0 t1 rc=0
  t0="$(now_ms)"
  "$@" || rc=$?
  t1="$(now_ms)"
  print_elapsed "${label}" "${t0}" "${t1}"
  return $rc
}

# print_elapsed "<标签>" <t0> [t1]  —— t1 缺省取当前时刻
print_elapsed() {
  local label="$1" t0="$2" t1="${3:-}"
  [ -n "${t1}" ] || t1="$(now_ms)"
  if [ -n "${t0}" ] && [ -n "${t1}" ]; then
    printf '   [%s] %s ms\n' "${label}" "$(( t1 - t0 ))"
  fi
}

# ---- 路径常量（基于脚本所在目录，跨机器通用，无需硬编码项目路径） ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}"
SRC_TAURI="${PROJECT_ROOT}/src-tauri"

T_SCRIPT_START="$(now_ms)"   # 整个脚本的起点，用于总耗时

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
print_elapsed "探测 Node.js" "${T_SCRIPT_START}"

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

# ---- npm 依赖：按需安装 ----
# 实测：依赖已同步时 `npm install` 仍要 ~23s（输出 "up to date"），
# 而只有引入新组件 / 改了 package.json 才真需要装。
# 判据：package.json + package-lock.json 的 SHA-256 与
#      node_modules/.minitc-deps-hash 比对，变了才跑。哈希与计时统一由
#      scripts/deps-hash.js 负责（dev.bat 共用同一份实现）。
# 强制安装：./dev.sh deps  或  MINITC_FORCE_INSTALL=1 ./dev.sh dev
ensure_deps() {
  local stamp="${PROJECT_ROOT}/node_modules/.minitc-deps-hash"
  local want
  want="$(node "${PROJECT_ROOT}/scripts/deps-hash.js")"
  if [ -z "$want" ]; then
    echo "[WARN] 无法计算依赖哈希，直接 npm install。"
    npm install || { echo "[ERROR] npm install 失败，请检查网络 / registry 设置。" >&2; exit 1; }
    return 0
  fi

  if [ "${MINITC_FORCE_INSTALL:-0}" != "1" ] && [ -d "${PROJECT_ROOT}/node_modules" ] \
     && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    echo ">> npm 依赖已同步，跳过 install（强制装：./dev.sh deps）"
    return 0
  fi

  echo ">> 安装 npm 依赖..."
  node "${PROJECT_ROOT}/scripts/deps-hash.js" --stamp "$stamp" --stamp-after-install \
    || { echo "[ERROR] npm install 失败，请检查网络 / registry 设置。" >&2; exit 1; }
}

# 强制安装版（./dev.sh deps）。注意：必须用普通函数，不能写成
# `env VAR=1 ensure_deps` —— env 只能跑外部可执行文件，跑不了 shell 函数。
force_deps() {
  MINITC_FORCE_INSTALL=1 ensure_deps
}

# ---- 各操作 ----
# 每个动作都包一层 step，最后汇总总耗时
run_dev() {
  local t_start="${T_SCRIPT_START}"
  echo ">> 启动开发模式 (Vite + Tauri 热更新)..."
  cd "${PROJECT_ROOT}"
  step "MSVC 环境" setup_msvc
  step "npm 依赖" ensure_deps
  step "tauri dev" npm run tauri dev
  print_elapsed "总计" "${t_start}"
}

run_build() {
  local t_start="${T_SCRIPT_START}"
  echo ">> 构建发布版本..."
  cd "${PROJECT_ROOT}"
  step "MSVC 环境" setup_msvc
  step "npm 依赖" ensure_deps
  step "tauri build" npm run tauri build
  echo ""
  echo ">> 构建完成! 产物位置:"
  echo "   exe: ${SRC_TAURI}/target/release/mini-tc.exe"
  echo "   安装包: ${SRC_TAURI}/target/release/bundle/"
  print_elapsed "总计" "${t_start}"
}

run_check() {
  local t_start="${T_SCRIPT_START}"
  echo ">> 检查 Rust 编译..."
  cd "${SRC_TAURI}"
  step "MSVC 环境" setup_msvc
  step "cargo check" cargo check
  print_elapsed "总计" "${t_start}"
}

run_clean() {
  local t_start="${T_SCRIPT_START}"
  echo ">> 清理构建产物..."
  cd "${SRC_TAURI}"
  step "cargo clean" cargo clean
  step "删除 dist" rm -rf "${PROJECT_ROOT}/dist"
  print_elapsed "总计" "${t_start}"
}

run_deps() {
  local t_start="${T_SCRIPT_START}"
  cd "${PROJECT_ROOT}"
  step "npm 依赖（强制）" force_deps
  print_elapsed "总计" "${t_start}"
}

# ---- 主入口 ----
step "探测 MSVC" detect_msvc
CMD="${1:-dev}"
case "$CMD" in
  dev)   run_dev ;;
  build) run_build ;;
  check) run_check ;;
  clean) run_clean ;;
  deps)  run_deps ;;
  *)
    echo "用法: $0 [dev|build|check|clean|deps]"
    echo "  dev   - 开发模式 (默认)"
    echo "  build - 构建发布版本"
    echo "  check - 仅检查 Rust 编译"
    echo "  clean - 清理构建产物"
    echo "  deps  - 强制执行 npm install"
    exit 1
    ;;
esac
