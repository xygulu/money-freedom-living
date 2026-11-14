# iOS 侧操作手册（Mac）

> 远端壳：页面全部来自线上站点 https://honghong.miller.ink ，壳只承载原生桥（推送 / 安全区 / 合规件）。
> **网页改动即时生效、免重新提审**；只有原生桥改动才需要出新包。
>
> 本文是「拿到 iPhone 上能装、能用」的最短路径。工程本身在仓库里（`shell/ios/`），
> 由 Linux 侧生成与维护（Capacitor 8 走 SPM，Mac 侧无需 pod install）。

## 0. 先决条件（缺一不可，TestFlight 的硬门槛）

| # | 条件 | 状态 | 说明 |
|---|---|---|---|
| 1 | **Apple Developer Program**（$99/年，个人主体即可） | ⛔ **未注册**（docs/11 M0 登记于 2026-09-25） | TestFlight 必须有它。它同时负责：App ID、证书、App Store Connect 账号 |
| 2 | Mac + Xcode | 用户自己的另一台 Mac | 无 Xcode 无法编译 iOS（Linux 不行，Swift 工具链 + iOS SDK 只有 macOS 有） |
| 3 | Xcode 登录 Apple ID | — | 自动签名要用；也可改用证书手动签名 |
| 4 | App Store Connect 建 App（bundle id `ink.miller.honghong`） | 待建 | App 记录要先建，才能上传构建 |
| 5 | App 展示名 | ⚠️ 现为占位「一辈子不愁钱的活法」 | TestFlight 上显示的就是它；中英文取舍待拍板（docs/11 M1） |

> **注册账号后**还要拿三样东西给后端配推送（不然推送静默降级成邮件，行为不变）：
> `APNS_P8`（.p8 密钥文件内容）+ `APNS_KEY_ID` + `APNS_TEAM_ID`（+ 开发包加 `APNS_ENV=sandbox`）。
> 后端三件套齐了才会走 push 通道（`pushConfigured()`）。

## 1. 拉代码

```bash
git clone <repo> && cd money-freedom-living/shell
pnpm install
```

## 2. 出包（一条命令）

```bash
./shell/ios/build-ipa.sh              # 自动取 Team ID
./shell/ios/build-ipa.sh ABCDE12345   # 或手动指定
```

脚本做三件事：`cap sync ios` → `xcodebuild archive` → `xcodebuild exportArchive`，
产出 `shell/ios/build/App.ipa`。

（若 Xcode 里手动操作：打开 `shell/ios/App/App.xcodeproj` → 选 App scheme → Any iOS Device →
Product → Archive → Distribute App → App Store Connect → Upload。）

## 3. 上传到 TestFlight

```bash
# 方式 A：Transporter.app（图形界面，最省事）
#   打开 App Store 的 Transporter，拖入 App.ipa，填 Apple ID + App 专用密码

# 方式 B：脚本（API Key，可自动化）
export ASC_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
export ASC_API_KEY_ID=XXXXXXXXXX
export ASC_TEAM_ID=XXXXXXXXXX
./shell/ios/upload-testflight.sh shell/ios/build/App.ipa
```

## 4. 在 App Store Connect 里放行给你自己

1. **我的 App → App → TestFlight** → 等构建处理完（5–30 分钟）
2. **创建外测组**（External Testing）→ 填你 iPhone 用的 **Apple ID 邮箱** → 添加构建
3. 手机上装 **TestFlight App**（App Store 搜）→ 接受邀请 → 点你的 App
   （首次接受邀请需要用**该邮箱**在 iCloud 里登录，或在 TestFlight App 里用该邮箱注册）

## 5. 常见卡点

| 现象 | 原因 | 处理 |
|---|---|---|
| `xcodebuild` 报签名错 | Xcode 没登录 Apple ID / Team ID 不对 | Xcode → Settings → Accounts 登录；或传 Team ID 给脚本 |
| 上传后构建一直「处理中」 | 通常是构建里带了不允许的 Info.plist 项 | 看 App Store Connect 的邮件；本工程已配 `ITSAppUsesNonExemptEncryption=false` + 麦克风用途说明 |
| App Store Connect 说 bundle id 已存在 | 之前建过同 id 的 App | 用那个记录，或在 Developer 后台换个 id（**改名窗口 = 门户建 App ID 之前**，见 docs/11 M0） |
| 上传成功但手机看不到 | 没建外测组 / 邮箱不匹配 / TestFlight App 没接受邀请 | 回到第 4 步逐项核 |

## 6. 已就绪的东西（别重复做）

- ✅ 工程：`shell/ios/App/App.xcodeproj`（SPM，共享 scheme 已补——Capacitor CLI 默认不落，脚本化构建会找不到）
- ✅ 合规件：Info.plist（麦克风用途说明 / 加密豁免 / 锁亮色 / 竖屏）
- ✅ 图标与启动屏：`scripts/make-ios-icons.mjs` 生成（占位视觉，定稿后重跑）
- ✅ 原生桥：推送（APNs 直发，后端 `push-apns.ts`）+ 剪贴板（ShellPaste 兜底）
- ✅ safe-area 与 16px 输入（web 侧已落地，真机验证等壳就绪）
