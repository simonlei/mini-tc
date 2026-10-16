#!/bin/bash
# 在 Git Bash 里跑 `cargo check`（仅检查编译，不产出二进制）。
#
# 与 dev.sh 的关系：本脚本是「只做 cargo check」的窄化版本 —— dev.sh 的
# `check` 子命令做的是同一件事，那条路径已经端到端验证过。这里保留独立
# 脚本是因为它跑得快（不探测 Node、不碰 npm），适合「改完 Rust 想快速
# 验一下语法」的场景。
#
# ⚠️ 历史包袱（本脚本此前与 dev.sh / check.bat / check.ps1 并存，四份
# 探测逻辑各写一遍、且互相漂移）：硬编码了 MSVC 版本号与本机绝对路径。
# 现在改成**动态探测 + 相对定位**，与 dev.sh 的 detect_msvc 保持同一套
# 判据。曾经的 check.ps1 更糟：它硬编码的 node 目录 `22.22.2` 实际叫
# `22.22.2-6`，即那条路径从来就不存在 —— 脚本是坏的，只是没人跑它。
#
# 与 dev.sh 的已知差异（如实记录，不假装一致）：
#   - dev.sh 还会探测 Node 并按 engines 选版本；本脚本不需要 node。
#   - dev.sh 的探测列表含 Community/Professional/Enterprise；
#     本脚本沿用同一份列表。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---- MSVC 探测（与 dev.sh 的 detect_msvc 同判据） ----
MSVC_BASE=""          # Git Bash 风格: /c/...
MSVC_WIN=""           # Windows 风格: C:\... (用于 INCLUDE/LIB)
SDK_BASE="/c/Program Files (x86)/Windows Kits/10"
SDK_WIN="C:\\Program Files (x86)\\Windows Kits\\10"
MSVC_VER=""
SDK_VER=""

for vsroot in \
  "/c/Program Files/Microsoft Visual Studio/2022/Community" \
  "/c/Program Files/Microsoft Visual Studio/2022/Professional" \
  "/c/Program Files/Microsoft Visual Studio/2022/Enterprise" \
  "/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools" \
  "/c/Program Files (x86)/Microsoft Visual Studio/2019/BuildTools" \
  "/c/Program Files (x86)/Microsoft Visual Studio/2019/Community" ; do
  if [ -d "$vsroot/VC/Tools/MSVC" ]; then
    # 取版本号最大的那个子目录（字典序不可靠：14.9 < 14.44 会排错）。
    MSVC_VER="$(ls -1 "$vsroot/VC/Tools/MSVC" 2>/dev/null \
      | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' \
      | sort -V \
      | tail -1)"
    if [ -n "$MSVC_VER" ]; then
      MSVC_BASE="$vsroot/VC/Tools/MSVC/$MSVC_VER"
      MSVC_WIN="${vsroot/#\/c\//C:}"
      MSVC_WIN="${MSVC_WIN//\//\\}\\VC\\Tools\\MSVC\\${MSVC_VER}"
      break
    fi
  fi
done

if [ -d "$SDK_BASE/Include" ]; then
  SDK_VER="$(ls -1 "$SDK_BASE/Include" 2>/dev/null \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -1)"
fi

if [ -z "$MSVC_BASE" ]; then
  echo "[WARN] 未找到 MSVC 工具链，依赖系统 rustup 默认工具链..." >&2
else
  echo ">> 设置 MSVC 编译环境 (MSVC ${MSVC_VER}, SDK ${SDK_VER})..."
  export PATH="${MSVC_BASE}/bin/Hostx64/x64:${SDK_BASE}/bin/${SDK_VER}/x64:${SDK_BASE}/bin/x64:$PATH"
  export INCLUDE="${MSVC_WIN}\\include;${SDK_WIN}\\Include\\${SDK_VER}\\shared;${SDK_WIN}\\Include\\${SDK_VER}\\ucrt;${SDK_WIN}\\Include\\${SDK_VER}\\um;${SDK_WIN}\\Include\\${SDK_VER}\\winrt;${SDK_WIN}\\Include\\${SDK_VER}\\cppwinrt"
  export LIB="${MSVC_WIN}\\lib\\x64;${SDK_WIN}\\Lib\\${SDK_VER}\\um\\x64;${SDK_WIN}\\Lib\\${SDK_VER}\\ucrt\\x64"
fi

cd "${PROJECT_ROOT}/src-tauri"
cargo check 2>&1