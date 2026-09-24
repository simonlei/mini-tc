#!/bin/bash
#=============================================================
# Mini TC (Windows native) - 发布脚本
# 用法:
#   ./win-release.sh v0.2.0      # 推送 main 并打标签，触发 GitHub Actions 构建
#   ./win-release.sh             # 自动取当前最新 win 版本，小版本号 +1 后发布
#                                # (最新为 win-v0.1.6 时等同于 ./win-release.sh v0.1.7)
#
# 做的事:
#   1. 校验版本号格式 (vX.Y.Z)；未给版本号时自动推导下一个补丁版本
#   2. 前置检查：工作区干净、github 远程存在
#   3. 推送 main 到 github 远程
#   4. 若标签已存在则先删除（本地+远端），再创建并推送 win-vX.Y.Z 标签
#      (触发 "Release (Windows native)" workflow)
#
# 版本号由 CI 从 tag 解析后传给 win-native/scripts/build-release.ps1
# （见 .github/workflows/win-native-release.yml 的 Resolve version 步骤），
# 本地不改源码，win-native/src/MiniTC/MiniTC.csproj 里的 <Version> 会被 -p:Version 覆盖。
#
# 远程默认是名为 github 的远程，可用 REMOTE=origin ./win-release.sh 覆盖。
#=============================================================

set -euo pipefail

# ---- 参数校验 ----
if [ $# -gt 1 ]; then
  echo "用法: $0 [vX.Y.Z]   (例: $0 v0.2.0；不带参数则自动 +1 小版本)"
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ---- 前置检查 ----
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "ERROR: 工作区有未提交的改动，请先处理："
  git status --short
  exit 1
fi

if [ ! -f "$ROOT/win-native/scripts/build-release.ps1" ]; then
  echo "ERROR: 未找到 win-native/scripts/build-release.ps1，请在仓库根目录执行本脚本。"
  exit 1
fi

REMOTE="${REMOTE:-github}"
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "ERROR: 未找到名为 '$REMOTE' 的远程，请检查 git remote -v"
  exit 1
fi

if [ $# -eq 1 ]; then
  VERSION="$1"
  if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: 版本号格式应为 vX.Y.Z (例: v0.2.0)，收到: $VERSION"
    exit 1
  fi
else
  # 不带参数：取本地 + 远端标签里最大的 win-vX.Y.Z，小版本号 +1
  LATEST="$(
    {
      git tag -l 'win-v[0-9]*.[0-9]*.[0-9]*'
      git ls-remote --tags "$REMOTE" 'refs/tags/win-v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null \
        | sed -e 's#.*refs/tags/##' -e '/\^{}$/d'
    } | sed -n 's/^win-//p' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
  )"
  if [ -z "$LATEST" ]; then
    echo "ERROR: 未找到任何 win-vX.Y.Z 标签，请显式指定版本号：$0 v0.2.0"
    exit 1
  fi
  IFS='.' read -r MAJOR MINOR PATCH <<<"${LATEST#v}"
  VERSION="v${MAJOR}.${MINOR}.$((PATCH + 1))"
  echo "==> 当前最新版本 $LATEST，自动发布下一版本 $VERSION"
fi

TAG="win-$VERSION"

echo "==> 发布 Windows native $VERSION (tag $TAG)"

echo "==> 推送 main 到 $REMOTE"
git push "$REMOTE" main

echo "==> 创建并推送标签 $TAG"
# 若标签已存在（本地或远端）则先删除，便于重发同一版本。
# 注意：删除 git 标签不会删除已关联的 GitHub Release，workflow 会复用
# 该 Release 并以 --clobber 覆盖同名资产。
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "    本地标签 $TAG 已存在，删除"
  git tag -d "$TAG"
fi
if git ls-remote --tags "$REMOTE" "refs/tags/$TAG" | grep -q .; then
  echo "    远端标签 $TAG 已存在，删除"
  git push "$REMOTE" --delete "$TAG"
fi
git tag "$TAG"
git push "$REMOTE" "$TAG"

echo ""
echo "✅ 完成。GitHub Actions \"Release (Windows native)\" 已由标签 $TAG 触发。"
echo "   https://github.com/simonlei/mini-tc/actions"
echo "   CI 会：dotnet test → publish win-x64 → vpk pack → 上传 Release 资源"
echo "   若配置了 COS 密钥，还会把 Velopack 更新源同步到 <cdn>/win-native/。"
