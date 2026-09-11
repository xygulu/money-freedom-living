# M8 Go/No-Go 报告

日期：2026-09-12（数据实测于 2026-09-11/12）
对应里程碑：docs/03 §10 M8「LLM en/ja 盲测、危机抽检、单位经济测算、Creem 确认 → 决定上线语言与参数」

## 1. 结论速览

| 验收项 | 结果 | 结论 |
|---|---|---|
| LLM en/ja 盲测 | en 9 条、ja 6/6 全日语、zh 4 条参照，全部真实管线出样 | **Go**（en）；ja 达标但见 §6 转正前置 |
| 危机抽检 | 16/16（en 8 + zh 8），`scripts/m8-safety-audit.mjs` | **Go** |
| 单位经济测算 | 实测 19 轮 + 3 次结算 token；敏感性表见 §4 | **Go**（flash 档价格下成本可控） |
| Creem 确认 | 沙箱全链路 18 断言通过；live 切换待账号主操作 | **Go**（沙箱）；上线按 §5 checklist |

**上线语言建议：en + zh-CN 立即上线（Go）；zh-TW / ja 暂缓（No-Go，缺口见 §6）。**

配套修复（本轮报障三件）已全部完成并回归验证：dev 跨源 403（allowedDevOrigins）、按钮无反应（同根因）、AI 回复字符级交错乱文（LLM 网关并发串流 → 全局串行锁 + 会话级互斥）。测试矩阵：`tsc` 0 错、vitest 80/80、playwright 真浏览器 7/7、串流并发回归 9/9、安全审计 16/16、Creem 沙箱 18/18。

## 2. LLM 盲测（en / ja）

方法：脚本注册真实账号 → 按语言开会话 → 走生产同一条 chat 管线（P§6 上下文组装 + GLM-5.3-flash 流式），输入覆盖发薪日空虚、原生家庭脚本、储蓄里程碑、社交消费压力、投资恐惧等主要金钱情结场景（`scripts/m8-go-samples.mjs`）。样本全文供盲评：`/tmp/m8-blind-samples.md`（不入库）。

结果：

- **en（9 条）**：全部地道英文，无翻译腔；有对用户原话的引用（如 "Nine years. … you paid off a credit card in full"），无越界理财建议，符合阶段一「只接住、不指导」姿态。
- **ja（6/6）**：全部标准日语（假名占比高、无英文夹句、无中文残留）。此前批次的英文开场已定位根因并修复：`enabledLocales` 未含 ja 时 route 将 ja 会话静默 fallback 到 en（按设计未开放），且 system 内嵌中文指令块会把开场语言带偏。修复 = LANGUAGE_RULES 四语钉死 + opener 占位与 Opening 指令块四语化（见附录 A2）。
- **zh-CN（4 条，参照）**：语气自然、不评判。
- 批次间波动记录：早期批次曾出现对新账号说 "welcome back"（虚构重逢）。四语 Opening 块约束后，最新批次开场已无虚构事实，仅中性问候。留观察。

结论：**en Go**。ja 语言质量达标，但转正还差内容层与母语校对（§6）；zh-TW 本轮无样本（M8 定义仅要求 en/ja），转正时按同流程补测。

## 3. 危机抽检

`scripts/m8-safety-audit.mjs`，16/16 通过：

- en 8 例 + zh 8 例（自伤/自杀指向、家暴、儿童受虐等），全部命中并返回服务端定死转介文案（不走 LLM、不消耗配额）。
- LLM 确认段故障时 fail-safe：宁可误报不漏报。
- 隐私纪律断言：`safety_events` 只落 `(user_key, source, category, handled, created_at)`，无内容列（information_schema 结构校验）；测试账号清理后计数归零。

注：当前词表仅 en + zh-CN（`content/safety/keywords/`）。ja/zh-TW 转正前必须补词表并重跑对应语言抽检（§6）——没有词表时关键词粗筛失效，仅靠 LLM 确认段兜底，不可接受。

## 4. 单位经济测算

实测（真实管线，`[llm] usage` 日志聚合，n=19 chat 轮 + 3 次结算）：

| 项 | 实测值 | 说明 |
|---|---|---|
| chat 每轮输出 | **avg 126 tok**（n=19） | max_tokens 上限 700，实际远低 |
| 结算/反思类调用 | **avg in 1,025 / out 154 tok**（n=3） | 非流式，usage 正常 |
| chat 每轮输入 | 网关流式不回（恒 0）→ 用预算上界估 | SYSTEM 12k 字符 + HISTORY 6k 字符 |

每轮输入估算：极端上界 ≈18k 字符 ≈ 10k tok；现实典型（阶段正文 3-5k 字符 + 历史 2-3k 字符）≈ 3-6k tok，下文按 **5k tok/轮** 计，另给上界栏。

月成本情景（30 天；配额：免费 3 会话/天、VIP 100 会话/天兜底、20 轮/会话上限）：

| 情景 | tokens/月 | 0.2 元/M | 1 元/M | 2 元/M |
|---|---|---|---|---|
| 免费典型（1 会话 8 轮/天） | ≈1.3M | 0.26 元 | 1.3 元 | 2.6 元 |
| 免费天花板（3×20 轮/天打满） | ≈9.3M | 1.9 元 | 9.3 元 | 18.7 元 |
| VIP 重度现实（10 会话×15 轮/天） | ≈23.5M | 4.7 元 | 23.5 元 | 47 元 |
| VIP 理论极值（100×20 轮/天打满） | ≈305M | 61 元 | 305 元 | 610 元 |

**glm-5.3-flash 刊例价未确认（内部网关），上表按 flash 档常见单价区间做敏感性，定价前以智谱刊例为准重算一遍（只需替换单价列）。**

读法与参数建议：

- 免费用户即使天天打满，flash 档价格下月成本个位数到十几元，Go。
- VIP 的 100 会话/天兜底正是为「理论极值」设的闸：极值情景月成本可能到几百元，定价须覆盖；真实重度用量（每月十几元量级）远低于极值。
- 上线后保留 `[llm] usage` 日志观察真实分布，一个月后用实测均值替换本表估算并收敛配额参数。
- 当前参数确认不变：`GUEST 1/天、FREE 3/天、VIP 100/天`、`CHAT_MAX_MESSAGES=40`、`SYSTEM_BUDGET=12_000`、`HISTORY_BUDGET=6_000`。

## 5. Creem 确认

沙箱全链路（checkout → verify → webhook → VIP 门禁）18 断言通过（`scripts/smoke-m8.mjs`）。

上线前置（需要 Creem 账号主在后台操作，代码侧无改动）：

1. 生产环境 `.env` 切 live API key（`CREEM_API_KEY` 等）。
2. Creem 后台配置生产 webhook 指向 `https://<域名>/api/payments/webhook/creem`，并校验签名密钥配置一致。
3. 用 live key 走一笔真实低额支付 + 退款，验证 webhook 到达与 VIP 生效/过期。

## 6. 上线语言决定与 zh-TW / ja 转正前置清单

| 语言 | 决定 | 前置缺口 |
|---|---|---|
| en | **Go** | — |
| zh-CN | **Go** | — |
| zh-TW | **No-Go（暂缓）** | ① `content/zh-TW/{journey,daily}` 未建（阶段引导会整块缺失）② 危机词表/转介资源 `content/safety/*/zh-TW.json` 未建 ③ 母语校对 ④ 盲测样本未采 |
| ja | **No-Go（暂缓）** | 同上四项（ja 版）；语言质量盲测已过（§2） |

转正流程：补齐 ①② → 母语校对 → 跑 `m8-go-samples.mjs`（该语言）+ `m8-safety-audit.mjs`（该语言词表）→ 通过后把该语言加进 `src/i18n/config.ts` 的 `enabledLocales`（语言选择器即自动解锁）。**注意：改 `enabledLocales` 需重启 dev server 才生效（Turbopack 对无浏览器连接时的服务端模块热载不生效）；生产 build 无此问题。**

## 附录 A：本轮修复清单

A1. 报障三件（全部已修并回归）：

1. 体检选项点不动 / 开始对话、注册按钮无反应：Next 16 dev 跨源保护 403 → `next.config.ts` `allowedDevOrigins` 补局域网 IP 与域名。
2. AI 回复字符级交错乱文：LLM 网关对并发 SSE 串流混写 → `src/lib/llm.ts` 全局串行锁（任一时刻至多一个 LLM 请求在途）+ `src/app/api/chat/[sessionId]/route.ts` 会话级流互斥（占坑与 429 预检同步原子，出口纪律：非流式 bail / 生成器 finally / 外层 catch 兜底）+ 前端 429 静默重试提示（`replyInProgress` 四语文案）。修复过程中回归脚本还抓出锁实现的首次获取自死锁 bug（`llmChain.then(() => gate)` 采纳 gate 自锁），已修（`scripts/repro-stream-mutex.mjs` 9/9）。

A2. i18n 语言钉死（盲测中发现）：

- `src/lib/prompt.ts`：新增 `LANGUAGE_RULES`（安全规则之后的最高优先级，四语强制输出语言，声明「指令本身是中文不构成用中文回复的理由」）；Opening 指令块四语化；远期记忆块对 en 的处理已有，其余语言 header 保留中文（内部脚手架，实测不致带偏）。
- `src/app/api/chat/[sessionId]/route.ts`：opener 占位用户消息按会话语言四语化。
- `src/lib/onboarding.ts`：`buildReflectMessages` 增加 locale 参数与输出语言指令（en 用户不再收到中文复述）。

A3. 测试矩阵：`tsc --noEmit` 0 错；vitest **80/80**；playwright 注册/登录真浏览器 7/7；串流并发回归 9/9；安全审计 16/16；Creem 沙箱 18/18。

## 附录 B：新增脚本（均已入库）

| 脚本 | 用途 |
|---|---|
| `scripts/repro-stream-mutex.mjs` | 双会话并发不交错 / 同会话 429 / 释放后可复用（9 断言） |
| `scripts/m8-safety-audit.mjs` | 双账号 16 危机例 + safety_events 隐私结构断言 |
| `scripts/repro-ux.mjs` | playwright 真浏览器注册→登录→交互冒烟 |
| `scripts/m8-go-samples.mjs` | 盲测样本批量出样 + 单位经济 usage 聚合 |
