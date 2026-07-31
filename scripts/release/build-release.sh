#!/bin/bash
# mini-tc 生产构建 + 发布准备脚本
# 用法：bash scripts/release/build-release.sh
# 前提：已设置 MSVC 环境变量

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")

echo "=== mini-tc v$VERSION Release Build ==="

# 1. 先编译前端
echo "[1/5] Building frontend..."
cd "$PROJECT_DIR"
npm run build

# 2. 设置签名密钥环境变量
KEY_FILE="$PROJECT_DIR/src-tauri/keys/mini-tc.key"
if [ ! -f "$KEY_FILE" ]; then
  echo "ERROR: Private key not found at $KEY_FILE"
  echo "Generate it with: npx tauri signer generate -p mini-tc-updater -w src-tauri/keys/mini-tc.key"
  exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY_PATH="$KEY_FILE"
echo "[2/5] Signing key loaded from $KEY_FILE"

# 3. 构建 Tauri (生成 .msi + .sig)
echo "[3/5] Building Tauri app (this may take a few minutes)..."
cd "$PROJECT_DIR"
npx tauri build 2>&1

# 4. 收集产物
echo "[4/5] Collecting artifacts..."

mkdir -p "$OUT_DIR"

# 找到 .msi 和 .sig 文件
BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/release/bundle"
MSI_FILE=$(find "$BUNDLE_DIR" -name "*.msi" -type f | head -1)
SIG_FILE=$(find "$BUNDLE_DIR" -name "*.msi.sig" -type f | head -1)
EXE_FILE=$(find "$BUNDLE_DIR" -name "*.exe" -not -name "*.sig" -type f | head -1)

if [ -z "$MSI_FILE" ]; then
  echo "ERROR: No .msi found in $BUNDLE_DIR"
  exit 1
fi

MSI_NAME=$(basename "$MSI_FILE")
SIG_NAME=$(basename "$SIG_FILE")

cp "$MSI_FILE" "$OUT_DIR/"
if [ -f "$SIG_FILE" ]; then
  cp "$SIG_FILE" "$OUT_DIR/"
fi

echo "  MSI: $MSI_NAME"
echo "  SIG: $SIG_NAME"

# 5. 生成 latest.json（更新清单）
echo "[5/5] Generating latest.json..."

SIGNATURE_CONTENT=$(cat "$SIG_FILE" 2>/dev/null || echo "")

cat > "$OUT_DIR/latest.json" << JSONEOF
{
  "version": "$VERSION",
  "notes": "See https://cnb.cool/simon-lei/mini-tc/-/releases for release notes.",
  "pub_date": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "platforms": {
    "windows-x86_64": {
      "signature": "$SIGNATURE_CONTENT",
      "url": "https://cnb.cool/simon-lei/mini-tc/-/releases/latest/download/$MSI_NAME"
    }
  }
}
JSONEOF

echo ""
echo "=== 构建完成 ==="
echo ""
echo "产物目录: $OUT_DIR"
echo ""
echo "发布步骤："
echo "1. 访问 https://cnb.cool/simon-lei/mini-tc/-/releases"
echo "2. 创建新 Release (Tag: v$VERSION)"
echo "3. 上传以下文件到 Release Assets:"
echo "   - $OUT_DIR/$MSI_NAME"
echo "   - $OUT_DIR/latest.json"
echo ""
echo "用户下次启动时将自动收到更新提示。"
echo "================================"
