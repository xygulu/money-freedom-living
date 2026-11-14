#!/usr/bin/env bash
# 上传 IPA 到 App Store Connect（TestFlight 的入口）。
#
# 用法（Mac 上）：
#   ./shell/ios/upload-testflight.sh shell/ios/build/App.ipa
#
# 认证二选一：
#   A) App Store Connect API Key（推荐，可自动化）：
#      export ASC_API_KEY=/path/to/AuthKey_XXXX.p8
#      export ASC_API_KEY_ID=XXXXXXX
#      export ASC_TEAM_ID=XXXXXXXXXX
#   B) Apple ID + App 专用密码（asc key 参数）：
#      ./shell/ios/upload-testflight.sh <ipa> <apple-id> <app-specific-password>
#      App 专用密码在 appleid.apple.com → 登录 → 安全 → 生成密码（名字随意，如 "testflight"）
set -euo pipefail

IPA="${1:-}"
if [ -z "$IPA" ]; then
  echo "用法：$0 <App.ipa> [apple-id] [app-specific-password]" >&2
  exit 1
fi
if [ ! -f "$IPA" ]; then
  echo "❌ 找不到文件：$IPA" >&2
  exit 1
fi

if [ -n "${ASC_API_KEY:-}" ] && [ -n "${ASC_API_KEY_ID:-}" ] && [ -n "${ASC_TEAM_ID:-}" ]; then
  echo "▶ 用 App Store Connect API Key 上传"
  xcrun altool --upload-app -f "$IPA" -t ios \
    --apiKey "$ASC_API_KEY" --apiIssuer "$ASC_API_KEY_ID"
elif [ -n "${2:-}" ] && [ -n "${3:-}" ]; then
  echo "▶ 用 Apple ID + App 专用密码上传"
  xcrun altool --upload-app -f "$IPA" -t ios \
    --username "$2" --password "$3"
else
  echo "❌ 缺认证。请设置 ASC_API_KEY / ASC_API_KEY_ID / ASC_TEAM_ID 三个环境变量，" >&2
  echo "   或传参：$0 <App.ipa> <apple-id> <app-specific-password>" >&2
  exit 1
fi

echo ""
echo "✅ 上传完成。接下来去 App Store Connect → 你的 App → TestFlight："
echo "   ① 等构建处理（5-30 分钟）"
echo "   ② 创建外测组 → 填你 iPhone 的 Apple ID 邮箱"
echo "   ③ 手机装 TestFlight App → 接受邀请 → 即可打开"
