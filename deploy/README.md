# 部署：节点来信（M11-E）

触达层的调度。**不配也能跑**——不配就是「这台机器不发信」，产品其他部分零影响。

## 1. 环境变量（写进 `.env.local`，不进仓库）

| 变量 | 作用 | 不配会怎样 |
|---|---|---|
| `RESEND_API_KEY` / `RESEND_FROM` | 发信通道（已被恢复码/删除确认复用） | `/api/touch/dispatch` 自动降级成试算，一封都不发 |
| `TOUCH_CRON_SECRET` | 调度端点的守门口令（随便一串长随机字符串） | 端点 503、脚本 exit 0 跳过 |
| `NEXT_PUBLIC_BASE_URL` | 信里「回到这里」与退订链接的域名 | 退回请求自身的 origin |

发信域名的 **SPF / DKIM / DMARC 必须配齐**（docs/05 §9.3 第 3 条）。不配这项等于没有触达——信进垃圾箱。

## 2. 先试算，别直接发

```bash
node --env-file=.env.local scripts/touch-dispatch.mjs            # 试算：算该发谁，一封不发
node --env-file=.env.local scripts/touch-dispatch.mjs --send     # 真发
```

输出里没有邮箱、没有 user_key、没有信的内容，只有数量与节点名。

## 3. 挂上 systemd timer

```bash
cp deploy/mfl-touch.service deploy/mfl-touch.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mfl-touch.timer
systemctl list-timers mfl-touch.timer     # 看下次触发时间
journalctl -u mfl-touch.service -n 50     # 看上一次跑的结果
```

一天一次。timer 误触发也不会重发——每个节点只发一次这件事是靠 `touch.sentNodes` 的
原子占位（`claimTouchNode`）保证的，不是靠「脚本不重复跑」。

## 4. 停掉

```bash
systemctl disable --now mfl-touch.timer
```

或者干脆把 `TOUCH_CRON_SECRET` 从 `.env.local` 里删掉——端点立刻关门。
