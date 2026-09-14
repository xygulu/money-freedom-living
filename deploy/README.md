# 部署：节点来信（M11-E）

触达层的调度。**不配也能跑**——不配就是「这台机器不发信」，产品其他部分零影响。

## 1. 环境变量（写进 `.env.local`，不进仓库）

| 变量 | 作用 | 不配会怎样 |
|---|---|---|
| `RESEND_API_KEY` / `RESEND_FROM` | 发信通道（已被恢复码/删除确认复用） | `/api/touch/dispatch` 自动降级成试算，一封都不发 |
| `TOUCH_CRON_SECRET` | 调度端点的守门口令（随便一串长随机字符串） | 端点 503、脚本 exit 0 跳过 |
| `NEXT_PUBLIC_BASE_URL` | 信里「回到这里」与退订链接的域名 | 退回请求自身的 origin |

发信域名的 **SPF / DKIM / DMARC 必须配齐**（docs/05 §9.3 第 3 条）。不配这项等于没有触达——信进垃圾箱。

当前发信身份（2026-02 起，临时）：`miller.ink`，暂借 honghong 的 Resend 发信域名。DNS 现状：

| 记录 | 现状 |
|---|---|
| DKIM `resend._domainkey.miller.ink` | ✅ 有（2048 位公钥） |
| SPF `send.miller.ink` TXT | ✅ `v=spf1 include:amazonses.com ~all` |
| 退信回收 `send.miller.ink` MX | ✅ `feedback-smtp.ap-northeast-1.amazonses.com` |
| DMARC `_dmarc.miller.ink` | ❌ **缺** |

DMARC 缺这条要补：Gmail / Yahoo 从 2024 年起要求批量发信方至少有 `p=none`，没有会被降权。
加一条 TXT `_dmarc.miller.ink` → `v=DMARC1; p=none; rua=mailto:<你的收件箱>` 即可。
**本产品正式上线前要换成自己的发信域名**——现在收信人看到的寄件人是 honghong 的域名，
和产品对不上；换域名 = 在 Resend 里新加 domain + 照它给的三条 DNS 记录配一遍。

## 2. 先寄一封给自己看

```bash
node --env-file=.env.local scripts/touch-preview.mjs                   # 只打印，不发
node --env-file=.env.local scripts/touch-preview.mjs --node D3 --locale en
node --env-file=.env.local scripts/touch-preview.mjs --send --to you@your.mail
```

用的是**合成档案**（`/api/touch/preview`），一行真实用户数据都不读也不写；信里的退订
token 是假的，点了只跳 `ok=0`——一封样信不该有动真实档案的能力。`--to` 不给就寄给
`SUPPORT_EMAIL`。

## 3. 再试算，别直接群发

```bash
node --env-file=.env.local scripts/touch-dispatch.mjs            # 试算：算该发谁，一封不发
node --env-file=.env.local scripts/touch-dispatch.mjs --send     # 真发
```

输出里没有邮箱、没有 user_key、没有信的内容，只有数量与节点名。

`@smoke.test` 一类的保留域名（RFC 2606：`.test` / `.example` / `.invalid` / `.localhost`
与 `example.com`）会被直接跳过，记在 `skipped.test_address` 里。smoke 每跑一次就留下几个
这种账号，真寄过去就是一串硬退——退信率是发信域名的命根子，攒够了真实用户也收不到信。

## 4. 挂上 systemd timer

```bash
cp deploy/mfl-touch.service deploy/mfl-touch.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mfl-touch.timer
systemctl list-timers mfl-touch.timer     # 看下次触发时间
journalctl -u mfl-touch.service -n 50     # 看上一次跑的结果
```

一天一次。timer 误触发也不会重发——每个节点只发一次这件事是靠 `touch.sentNodes` 的
原子占位（`claimTouchNode`）保证的，不是靠「脚本不重复跑」。

## 5. 停掉

```bash
systemctl disable --now mfl-touch.timer
```

或者干脆把 `TOUCH_CRON_SECRET` 从 `.env.local` 里删掉——端点立刻关门。
