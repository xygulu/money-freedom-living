# docs/11 · iOS 版规划（V0.3 候选，2026-09-25 起草）

> 用户 2026-09-25 拍板：要出 iOS 版本，**先不含管理后台**。同日 M0 四项全部拍板（§6），壳工程骨架已落（§3 M1）；编译/签名/推送密钥等 Mac 侧与账号侧动作见 §7。
> P0 批已闭环（每日两问/L4L5M/node_verdict 都在码上）；P1 七条经用户确认**暂缓**，iOS 优先。

## 0. 结论先行

**推荐 Capacitor 远端壳**：现有 Next.js 全栈一字不动（后端 / DB / 认证 / 内容层全复用），iOS 端 = 一个指向线上站点的原生壳 + 少量原生能力（推送、安全区、上架合规件）。不做原生重写，不做纯 PWA。

**远端壳最大的运维红利**：页面改动即时生效、免重新提审——只有原生桥（推送插件等）改动才需要发新版本。web 端照常按现在节奏迭代。

## 1. 路线比选（为什么是壳）

| 路线 | 工程量 | 推送 | 能否上架 | 判定 |
|---|---|---|---|---|
| PWA（添加到主屏幕） | ≈0 | iOS 16.4+ 勉强支持 | ❌ 不能上架 | 只作过渡验证，不是交付物 |
| **Capacitor 远端壳** | **小（周级）** | ✅ APNs | ✅ | **推荐** |
| Expo / React Native 重写 | 大（月级） | ✅ | ✅ | 全 UI 重写，现阶段不值 |

壳被拒风险（ guideline 4.2「最小功能」）：靠真实原生能力达标——推送召回、原生启动屏/图标/手势、Sign in with Apple。纯浏览器壳才危险，带原生桥的 hybrid 是常见过审形态。

## 2. 复用面（不动的，已核实）

- **后端全部**：Next.js API + RSC 页面、Neon、BetterAuth、内容层/发布闸/确认闸。
- **删号**：`/api/me/delete` 已存在——满足 Apple 5.1.1(v)「app 内可删号」。
- **导出**：`/api/me/export` 已存在——App Privacy / Data Safety 表好填。
- **STT**：MediaRecorder 采集 → `POST /api/journey/speech` 服务端转写——**不依赖 Web Speech API**，iOS WebView 可用，不需要原生语音桥（60 秒封顶逻辑照旧）。
- **管理后台排除**：壳只承载用户侧页面；`/admin` 对非白名单本就 404；M1 再加壳内导航黑名单，双保险。

## 3. 里程碑

### M0 · 决策与准备 —— ✅ 2026-09-25 用户四项全部拍板

1. **Apple Developer 账号**：**个人主体，尚未注册**（$99/年）。→ 待办：注册 Apple Developer Program；注册后需要拿到 **Team ID + APNs Auth Key（.p8 文件 + Key ID）** 给后端配推送。
2. **构建路径**：**用户自己的另一台 Mac**（验收侧 mac 之外还有设备）。→ Mac 侧流程见 §7。
3. **首版要不要推送**：**要**。→ M2 全量在册：APNs + device token 通道 + 触达调度加 push 通道；权限请求时机 = 首次「今天这一步」之后。
4. **付费形态**：**同意首版免费无墙**——先测 iOS 上的效果，再考虑付费（IAP 3.1.1 约束届时单独拍板）。

### M1 · 壳工程（✅ 代码侧全齐——骨架/Info.plist/safe-area/16px/图标启动屏，2026-10-02；剩 Mac 编译签名 + 展示名 + 真机滚动手感）

- ✅ **Capacitor 8.5.2 远端壳**（`shell/`，与 Next 应用完全隔离）：`server.url` → `https://honghong.miller.ink` + `allowNavigation`（桥注入，推送可用）；bundle id `ink.miller.honghong`（改名窗口 = 门户建 App ID 前）；ios 工程已在 Linux 生成（Cap 8 走 SPM，Mac 侧无需 pod install）。
- ✅ **Info.plist 已配**：`NSMicrophoneUsageDescription`（STT 麦克风必需，无则崩）、iPhone 竖屏锁定、`UIUserInterfaceStyle: Light`（首版锁亮色）、`ITSAppUsesNonExemptEncryption: false`（HTTPS-only 豁免，M3 提前）。
- ✅ **图标 / 启动屏（占位版，2026-10-02）**：程序化生成（`scripts/make-ios-icons.mjs`，Node 手写 PNG 编码器，Linux 无 ImageMagick/sharp 也能复跑）——暖纸底 + 硬币新芽、产品色板同源；正式视觉定稿后改脚本重跑即整体替换。⏳ 产品展示名待定（中英文取舍，现为「一辈子不愁钱的活法」占位）。
- ✅ **safe-area 适配**：`viewport-fit=cover` + `env(safe-area-inset-*)`——**web 侧已于 2026-09-25 先行落地**（body 四边 env padding + 经典 sticky 条 + 陪伴者钮/提交面板/聊天弹层三处 calc 补边，见 docs/03 §11）；真机验证等壳就绪。**遗留项已销（2026-10-02，A 案）**：输入控件全局提到 16px（`input/select/textarea` 一条 `!important` 规则），iOS 聚焦不再自动放大；桌面观感差异仅在控件本身。
- ⏳ iOS 滚动手感（橡皮筋、输入法顶起）——真机上手后调。
- ⏳ 壳内导航黑名单：`/admin*` 拦在 WebView 外（双保险）——第一道（白名单外 404）已有；第二道待做（web 侧识别 Capacitor 环境时 /admin 跳回首页）。

### M2 · 原生桥 —— ✅ 后端+壳侧代码已全部落地（2026-09-25，docs/03 §11），只欠密钥与真机验证

- **推送**（✅ M0 已拍板：要）：**已完成**——`growth_profiles.push_tokens` 行内列表（零新表，导出/删号/游客迁移随行）；`pickTouchNode` 通道参数（email/push 共享节点状态，同一节点绝不双轰，token 在走 push、没有走 email）；APNs HTTP/2 直发（`src/lib/push-apns.ts`，.p8 签 JWT，jose）；`POST/DELETE /api/me/push` 上报路由；壳内注册时机=首次「今天这一步」提交成功后（`src/lib/push-register.ts`）；`PushTapBridge` 通知点按站内跳转。**待办**：① Apple 账号注册后把 `.p8 + Key ID + Team ID` 配进 env（`APNS_P8/APNS_KEY_ID/APNS_TEAM_ID`，开发构建另配 `APNS_ENV=sandbox`）——没配时调度整体回落 email，行为零变化；② 真机验证：权限弹窗时机/到达/点按跳转/卸载摘牌。
- **Sign in with Apple**：**只要登录页露出任何第三方登录（Google 等）就必须提供**；BetterAuth 有现成 provider。若首版只保留邮箱+游客，可不做（现登录页=邮箱+游客 → 首版暂不做）。
- **Universal Links**：召回邮件/推送的链接直达 app 内对应页（未装则回落 web）。推送点按已由 tap 桥覆盖；此项只剩邮件链接直达，留待有需要再做。

### M3 · 合规件（纯文案+配置，1-2 天）

- ✅ **隐私政策 URL**：`/{locale}/privacy` 四语页已存在（`src/lib/privacy.ts`，着陆页有链接）——提审直接填 `https://honghong.miller.ink/zh-CN/privacy`（2026-10-02 复查）。
- ✅ **Export Compliance**：Info.plist `ITSAppUsesNonExemptEncryption: false` 已配（HTTPS-only 豁免）。
- ✅ **删号入口可见性复查（2026-10-02）**：主导航「我的」（layout `nav.me`）含恢复码/导出/删号账户区，archive 页亦直链 `/me#delete`——满足 5.1.1(v)；真机再过一遍层级手感。
- ⏳ App Privacy 表（收集：邮箱/档案内容/诊断；不追踪）——提审时在 App Store Connect 填。

### M4 · TestFlight → 提审

- TestFlight 内测（用户 + 验收侧），跑通：首启向导→测试→旅程→一格提交→STT→删号/导出。
- 截图（6.7" 一套即可起步）+ 描述 + 隐私政策链接 → 提审（周期 1-3 天）。
- 常见拒点预案：4.2 壳太薄（→强调推送/原生手感）、3.1.1 支付（→首版无付费墙）、5.1.1 删号（→已满足）。

## 4. 与存量待办的牵连

- **P1-1（生产模式）被本任务提前**：壳指向的必须是 `next build && next start` 的生产站点——不能让 iOS 用户落在 dev 模式上。这是 iOS 前置里唯一必须先动的存量项。
- **P1-3（发信域名）不影响 app 过审**：推送走 APNs 不走邮件域名——iOS 反而给触达开了第二条道。
- **游客模式在 iOS 的弱点**：WebView storage 随卸载丢失——推送 + 恢复码引导（P1-7）在 iOS 上比 web 更重要，M2/M3 顺手把 P1-7 的引导做了。

## 5. 明确不做（本期）

- Expo/RN 原生重写；Android（壳可复用，等 iOS 过审后照搬）；管理后台进壳；IAP 支付（等 U12 + 拍板）；widget/Watch 等原生 surface。

## 6. M0 拍板记录

✅ 2026-09-25 全部落定（详情见 §3 M0）：个人账号（待注册）／用户自有 Mac 构建／首版要推送／首版免费无墙。

## 7. Mac 侧操作清单（用户的另一台 Mac，账号注册后）

1. `git clone`/`git pull` 本仓库 → `cd shell`
2. `pnpm install && pnpm exec cap sync ios`（Linux 侧已生成 ios 工程，Mac 上补 pod install）
3. 注册 Apple Developer Program（个人，$99/年）→ 开发者门户建 **App ID**（bundle id `ink.miller.honghong`，改名窗口 = 首次上传前）+ **APNs Auth Key（.p8，记 Key ID）**
4. Xcode 打开 `shell/ios/App` → Signing & Capabilities 选个人 Team、勾 **Push Notifications** capability
5. `npx cap open ios` 真机跑通 → Product → Archive → TestFlight

服务器侧需要的密钥（配推送时给）：.p8 文件、Key ID、Team ID——走私下渠道，不进仓库。
