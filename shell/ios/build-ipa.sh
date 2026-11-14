#!/usr/bin/env bash
# iOS 一键出包（Mac 侧）：sync → archive → 导出 IPA。
#
# 用法（Mac 上，仓库根目录）：
#   ./shell/ios/build-ipa.sh [TEAM_ID]
#   BUILD_NUMBER=7 ./shell/ios/build-ipa.sh ABCDE12345   # 指定构建号
# 不给 TEAM_ID 时从 Xcode 里已登录的账号自动取（xcodebuild -showBuildSettings）。
# 构建号不指定则自动递增（TestFlight 拒绝重复 build 号——上传第二次必须换号）。
#
# 前置（一次性）：
#   1. Apple Developer Program 已注册（$99/年）——TestFlight 的门槛，没有它本脚本跑不了上传
#   2. Xcode 已装，且 `xcodebuild -version` 可用
#   3. Xcode → Settings → Accounts 里登录了 Apple ID（自动签名要用）
#   4. App Store Connect 已建好 App（bundle id = ink.miller.honghong）
#
# 产出：shell/ios/build/App.ipa（可直接上传 TestFlight）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IOS_DIR="$ROOT/shell/ios"
PROJECT="$IOS_DIR/App/App.xcodeproj"
SCHEME="App"
BUNDLE_ID="ink.miller.honghong"
OUT_DIR="$IOS_DIR/build"

cd "$ROOT"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "❌ 找不到 xcodebuild——这个脚本必须在 macOS + Xcode 上跑" >&2
  exit 1
fi

TEAM_ID="${1:-}"
if [ -z "$TEAM_ID" ]; then
  TEAM_ID=$(xcodebuild -project "$PROJECT" -scheme "$SCHEME" -showBuildSettings 2>/dev/null \
    | awk -F' = ' '/DEVELOPMENT_TEAM/ {print $2; exit}' | tr -d ' ')
fi
if [ -z "$TEAM_ID" ]; then
  echo "❌ 取不到 DEVELOPMENT_TEAM。两种办法二选一：" >&2
  echo "   a) Xcode → Settings → Accounts 登录 Apple ID 后重跑" >&2
  echo "   b) 直接传参：./shell/ios/build-ipa.sh ABCDE12345" >&2
  exit 1
fi
echo "▶ Team ID: $TEAM_ID"

# 构建号：TestFlight 拒绝重复 build 号（同一个号只能上传一次）——自动递增，
# 记录在 build/build-number.txt（build/ 不入库）。要指定就 BUILD_NUMBER=7。
BUILD_NUMBER_FILE="$OUT_DIR/build-number.txt"
if [ -n "${BUILD_NUMBER:-}" ]; then
  CURRENT_BUILD="$BUILD_NUMBER"
else
  CURRENT_BUILD=$(( $(cat "$BUILD_NUMBER_FILE" 2>/dev/null || echo 0) + 1 ))
fi
mkdir -p "$OUT_DIR"
echo "$CURRENT_BUILD" > "$BUILD_NUMBER_FILE"
echo "▶ 构建号（build number）: $CURRENT_BUILD"

# 1) 同步 web 与插件（远端壳：页面在线上，sync 只是把插件与配置对齐）
#    **必须用本地 CLI**（版本与 package.json 对齐）：用临时下载的最新版 CLI 会重新生成
#    Package.swift / Gradle 配置，版本与已装的 @capacitor/core 错配。
echo "▶ cap sync ios"
(cd "$ROOT/shell" && ./node_modules/.bin/cap sync ios)

# 2) archive
mkdir -p "$OUT_DIR"
echo "▶ xcodebuild archive"
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$OUT_DIR/App.xcarchive" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  MARKETING_VERSION=1.0 CURRENT_PROJECT_VERSION="$CURRENT_BUILD" \
  clean archive

# 3) 导出 IPA（app-store-connect 方法 = 给 TestFlight/上架用）
cat > "$OUT_DIR/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>teamID</key>
  <string>__TEAM_ID__</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>uploadSymbols</key>
  <true/>
  <key>destination</key>
  <string>upload</string>
</dict>
</plist>
PLIST
sed -i '' "s/__TEAM_ID__/$TEAM_ID/" "$OUT_DIR/ExportOptions.plist"

echo "▶ xcodebuild exportArchive"
xcodebuild \
  -exportArchive \
  -archivePath "$OUT_DIR/App.xcarchive" \
  -exportOptionsPlist "$OUT_DIR/ExportOptions.plist" \
  -exportPath "$OUT_DIR"

echo ""
echo "✅ 出包完成：$OUT_DIR/App.ipa"
echo ""
echo "下一步（上传 TestFlight）："
echo "  方式 A（省事，图形界面）：打开 Transporter.app → 拖入 App.ipa → 填 Apple ID 与 App 专用密码 → 上传"
echo "  方式 B（脚本）：./shell/ios/upload-testflight.sh $OUT_DIR/App.ipa"
echo ""
echo "上传后在 App Store Connect → 我的 App → TestFlight："
echo "  ① 等构建处理完（通常 5-30 分钟）"
echo "  ② 创建外测组，填你 iPhone 的 Apple ID 邮箱"
echo "  ③ 在手机装 TestFlight App → 接受邀请 → 打开即可"
