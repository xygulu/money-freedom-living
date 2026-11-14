# 设计稿 · 多 provider 自动 failover

> 状态：**已锁定决策（2026-09-16 用户拍板 4 条），待实施**
> 作者：编码侧 · 2026-09-16
> 触发：用户 2026-09-16 指令「做成多 provider 模式，故障自动切换」
> 适用范围：`src/lib/llm.ts`（核心）、所有调用 `llmStream` / `llmComplete` / `llmCompleteJson` 的下游（13 个调用点）
> 实际改动量：约 740 行（详见 §8.5）

---

## 一、问题陈述（从 zhipu 崩说起）

### 1.1 现场

`/tmp/mfl-dev.log` 2026-09-15 记录：

```
TypeError: Cannot read properties of undefined (reading 'type')
  at src/lib/llm.ts:180 (event.delta.type === 'text_delta')
```

触发路径：访客走 onboarding talk → 第 5 轮用户答完 → LLM 生成复述开始 SSE 流 → zhipu Anthropic 兼容网关推了一个 `event.delta === undefined` 的畸形 event → `rawLlmStream` 在 line 180 抛 TypeError → 当前 provider 被判失败 → **外层 failover 循环判断 `started === false`（因为还没 yield 任何 text）→ 切下一个 provider** → 下一个 provider 重新发起流 → 又遇相同畸形 event → 再切 → 全列切完 → 抛 `LLM 调用失败`。

**结果**：用户看到「出了点问题，请重试」，但是**所有 provider 都在 stream 早期就死了**——本来"切下一个 provider 重发这条消息"就能恢复（zhipu 那个畸形 event 后续正常），用户体验不该被牺牲。

### 1.2 现有 failover 行为（src/lib/llm.ts:163-194）

| 失败时机 | 行为 |
|---|---|
| `stream = provider.messages.stream(...)` 这一行 throw | ✓ 切下一个 provider（line 187 catch） |
| for-await 第 1 个 event 即抛 | ✓ 切下一个 provider（`started=false`，line 190 catch） |
| for-await 已 yield ≥1 chunk 后再抛 | ✗ 异常冒泡到调用方，**不再 fallback** |
| provider 在 for-await 中**沉默不发 event**（卡死 / 一直 ping） | ✗ 无超时，无 fallback，hang 到底 |
| provider 在 for-await 中推 **畸形 event**（如 zhipu 现象） | △ 第 1 个就抛能切；中途抛不能切 |
| provider **正常完成**但推的是**脏数据**（含安全词 / 内容违规） | ✗ 完全没判 |

### 1.3 范围外的失败

- **provider 池本身没数据**：env 没配 → `getLlmProviders()` 返回空 → 调用方早 throw。本设计稿不解决（属于部署配置）。
- **配额 / 限流（429）**：当前 catch 一律判失败。本设计稿要做「429 标记 cooldown，不耗 provider 槽」——见 §5。

---

## 二、设计目标 & 非目标

### 2.1 目标

1. **stream 中途 provider 死了，自动切下一个 provider 重发当前消息**——这是用户原话「故障自动切换」的核心语义。
2. **provider 健康状态有记忆**（circuit breaker lite）：连续失败 N 次进入 cooldown，cooldown 内不进 list，避免每个请求都重试已知死的 provider。
3. **畸形 event 不再抛 TypeError**：sse 解析阶段**容错**，无效 event 记日志后跳过，不影响 yield 链。
4. **provider 配置可观测**：每次调用 / 切换 / 失败都有结构化日志 + 写入 `llm_provider_events` 表（**已锁定**，per 用户 2026-09-16 决定），**不写敏感字段**（per CLAUDE.md 凭据约束）。
5. **不改变调用方签名**：`llmStream(opts)` / `llmComplete(opts)` / `llmCompleteJson(opts)` 三个对外函数签名不变——下游 13 个调用点零改动。

### 2.2 非目标

- 不引入"按消息内容选 provider"（per-call routing）——本期不实现。
- 不引入 provider 权重 / 成本模型。
- 不改 env 命名（`ANTHROPIC_*` / `LLM_PROVIDER_2_*` 维持）。
- 不增加 provider 自动发现 / 注册中心（管理后台负责，下一份设计稿）。
- **不**做"用户感知的重试 UI"——流式响应里 splice 已 yield 的 chunk 是 LLM SDK 层面难题；本期策略是"失败透明 → 整个请求级 fallback"（见 §3.2）。

---

## 三、核心设计

### 3.1 三层模型

```
┌──────────────────────────────────────────────────────────────┐
│ L1 · ProviderHealth（内存）                                   │
│   - 每个 provider 一个滑动窗口（last 20 calls）               │
│   - 字段：consecutiveFailures, cooldownUntil, lastError       │
│   - 跨调用共享（module-level Map<id, Health>）                │
│   - 持久化？—— 不（重启即清；这是冷启动优化，不是 SLO 保证） │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ L2 · LlmProvider（含 cooldown 标记）                          │
│   - 字段：id, label, baseURL, model, apiKey, enabled         │
│   - 构造期读 env；运行期 enabled 由 L1 翻动                  │
│   - enabled=false 的 provider 完全跳过，不进 retry 循环      │
└──────────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────────┐
│ L3 · StreamGuard（流级容错）                                  │
│   - 包住 SDK stream：对每个 event 做 try/catch                │
│   - 畸形 event（delta undefined / type 未知）→ log + skip     │
│   - 流超时（默认 60s 无任何 event）→ 抛超时异常               │
│   - 流已 started 后抛 → 触发 L1 记录失败 → fallback           │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Stream 中途失败的 fallback 策略——「整请求级重发」

> 关键决策：**不在 stream 中 splice chunk**（实现复杂 + 边界多），而是
> **失败 → 记 L1 → 用下一个 provider 重发整条请求**。
> 对调用方透明，但代价：用户能看到一段已生成的文本**然后报错**——这是已知取舍。

| 失败时机 | 用户感知 | 行为 |
|---|---|---|
| Stream 第 0 chunk 失败 | 无感（没东西可丢） | 切下一个 provider，整请求重发 |
| Stream 第 N≥1 chunk 后失败 | **已显示 N chunk 的 UI** | 切下一个 provider，整请求重发（**用户看到的内容是新 provider 的，旧 chunk 留在页面上无法回收**） |
| 所有 provider 失败 | "出了点问题，请重试" | 当前文案保持 |
| 上游 NextResponse 已写部分 SSE 头 | — | 这是 §3.4 的范畴，本期**接受**：重发会让用户看到两段拼接 |

**前端配套**：在 stream 失败切 provider 时，前端是否要清空当前对话气泡？——**本期不做**，但留 hook：

```ts
// OnboardingWizard / ChatView 监听"stream 重启"事件：
// 切 provider 时，前端可以收到 onProviderSwitch 事件，
// 决定要不要 append "[providerA 失败，已切换 providerB]" 标记。
```

### 3.3 Circuit breaker lite 规则

```
连续失败 n 次（默认 3）→ cooldown
cooldown 时长：指数退避，10s / 30s / 60s / 300s（封顶 5 分钟）
cooldown 结束 → 该 provider 重新尝试一次
一次成功 → 重置 consecutiveFailures = 0
429（限流）：不算 consecutiveFailures，但触发单次 30s cooldown（避免把限流当成硬故障）
```

> 为什么不直接用 opossum / cockatiel：项目目前无任何 circuit-breaker 依赖，引入需要 `pnpm-lock.yaml` 调整 + pnpm 审批。**手动实现** ~80 行 TS，覆盖本场景。

### 3.4 SSE 解析容错（关键 bug 修复）

```ts
// 当前 src/lib/llm.ts:175-184
for await (const event of stream) {
  if (event.type === 'message_start' || event.type === 'message_delta') {
    usage = event.message?.usage ?? usage;
  }
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    started = true;
    yield event.delta.text;  // ← zhipu 畸形 event 在这抛 TypeError
  }
}
```

改为：

```ts
for await (const event of stream) {
  try {
    if (!event || typeof event !== 'object') {
      logProviderEvent({ provider: id, kind: 'malformed_event', event: String(event).slice(0, 200) });
      continue;
    }
    if (event.type === 'message_start' || event.type === 'message_delta') {
      usage = event.message?.usage ?? usage;
      continue;
    }
    if (event.type === 'content_block_delta') {
      if (!event.delta || event.delta.type !== 'text_delta') {
        logProviderEvent({ provider: id, kind: 'delta_no_text', deltaType: event.delta?.type });
        continue;
      }
      started = true;
      yield event.delta.text;
      continue;
    }
    // 其他已知类型（content_block_start/stop/message_stop/ping）安静跳过
    continue;
  } catch (e) {
    logProviderEvent({ provider: id, kind: 'event_handler_throw', err: shortErr(e) });
    // 单 event 解析抛错不能影响整流
  }
}
```

### 3.5 429 / 5xx 的特殊处理

```ts
try {
  stream = provider.messages.stream(...);
  break;  // 拿到 stream 了
} catch (e) {
  if (isRateLimit(e)) {
    health.recordRateLimit(provider.id);  // 不算 consecutiveFailures
    continue;
  }
  if (isServerError(e)) {  // 5xx
    health.recordFailure(provider.id);
    continue;
  }
  // 4xx（除 429）通常是配置错，跳过且**标记 cooldown 5min**（避免反复重试）
  health.recordConfigError(provider.id);
  continue;
}
```

`isRateLimit` / `isServerError` 通过 SDK 抛出的 SDKError 子类判（`@anthropic-ai/sdk` 的 `APIError.status`）。

---

## 四、接口契约

### 4.1 LlmProvider（变化）

```ts
// src/lib/llm.ts:18-43
export interface LlmProvider {
  id: string;           // 'zhipu' | 'provider-2' | ...
  label: string;
  baseURL: string;
  model: string;
  apiKey: string;
  enabled: () => boolean;   // ← 新增：L1 健康判定
  recordSuccess(): void;    // ← 新增
  recordFailure(reason: FailureKind): void;  // ← 新增
  recordRateLimit(): void;  // ← 新增
}
```

> **注意**：把 `enabled` 做成函数而不是 boolean，是为了避免每次重读 health map 时 clone provider 对象。

### 4.2 ProviderHealth（新增）

```ts
// src/lib/llm-health.ts (新文件)
export type FailureKind = 'server_5xx' | 'stream_throw' | 'config_4xx' | 'timeout';

interface HealthState {
  consecutiveFailures: number;
  cooldownUntil: number;  // epoch ms
  lastErrorKind: FailureKind | null;
  lastErrorAt: number | null;
}

export class ProviderHealth {
  private states = new Map<string, HealthState>();
  
  getEnabledProviders(providers: LlmProvider[]): LlmProvider[];
  recordSuccess(id: string): void;
  recordFailure(id: string, kind: FailureKind): void;
  recordRateLimit(id: string): void;
  
  // 诊断用：导出当前状态快照（admin 后台会用）
  snapshot(): { id: string; consecutiveFailures: number; cooldownUntil: number; lastErrorKind: FailureKind | null; }[];
}
```

### 4.3 对外签名（不变）

```ts
// 下游 13 个调用点零改动
export function llmStream(opts: LlmStreamOptions): AsyncIterable<string>;
export function llmComplete(opts: LlmCompleteOptions): Promise<string>;
export function llmCompleteJson<T>(opts: LlmCompleteJsonOptions<T>): Promise<T>;
```

唯一新增：`llmStream` 多了一个**可选**回调 `onProviderSwitch?: (from: string, to: string, reason: FailureKind) => void`，默认 undefined——调用方不传则行为完全等同现状。

### 4.4 结构化日志（新增）

```ts
// src/lib/llm-log.ts (新文件)
export interface LlmLogEvent {
  ts: string;          // ISO
  provider: string;
  callId: string;      // crypto.randomUUID()
  kind: 'start' | 'success' | 'failure' | 'switch' | 'malformed_event' | 'timeout';
  errorKind?: FailureKind;
  // 严禁：apiKey / baseURL / prompt / response text
  durationMs?: number;
  chunksYielded?: number;
}
```

**写入位置**：`console.info` / `console.warn`（dev） + **新建表 `llm_provider_events`**（已锁定，per 用户 2026-09-16 决定）。表结构见 §8.2。admin 后台 `provider` 健康面板**同时**读 `ProviderHealth.snapshot()`（实时）和 `llm_provider_events` 过去 24h 失败率（历史），接口在 §8.4。

---

## 五、行为表（合并现有 + 设计后）

| 场景 | 现状 | 设计后 |
|---|---|---|
| env 只配了 zhipu，另一个畸形 | 一直崩 | 切到 provider-2 正常出 |
| env 只配了 zhipu，没备用 | 一直崩 | zhipu cooldown 10s 后重试一次；再失败 cooldown 30s；最终 throw "所有 provider 不可用" |
| zhipu 推畸形 event（第 1 个） | 切下一个 provider | 同上（兼容） |
| zhipu 推畸形 event（中途） | 异常冒泡给调用方 | 容错跳过该 event；继续 yield 后续正常 event |
| zhipu 流 60s 无任何 event | 永久 hang | 超时抛 `LlmTimeoutError` → fallback |
| 所有 provider 429 | 一律 fallback 完 throw | **rate limit 不算硬故障**，cooldown 30s 后再试，可能 429 期间另一个 provider 空闲 |
| admin 想看"现在哪个 provider 在 cooldown" | 无可见性 | `ProviderHealth.snapshot()` 给 admin 路由读 |

---

## 六、改动文件清单

| 文件 | 改动 | 行数估算 |
|---|---|---|
| `src/lib/llm.ts` | 重写 stream / complete / completeJson 三个函数走 L1；新增 timeout；SSE 容错 | ~+120 行 |
| `src/lib/llm-health.ts` | **新文件**：`ProviderHealth` class | ~80 行 |
| `src/lib/llm-log.ts` | **新文件**：`logProviderEvent()` 工具 | ~30 行 |
| `src/tests/llm-failover.test.ts` | **新文件**：mock Anthropic SDK，覆盖 6 个场景 | ~150 行 |
| `src/tests/llm-sse-parse.test.ts` | **新文件**：sse 容错单元测试 | ~80 行 |
| `docs/03 §11` | 加修订记录 | +10 行 |
| `docs/02 §12` | 加产品口径 | +5 行 |
| `docs/08` | 不动（不是 bug） | — |

**总改动**：5 个源文件 + 2 个文档，约 460 行。**没有下游 13 个调用点的改动**。

---

## 七、风险与约束

### 7.1 已知取捨

- **整请求级重发**：已 yield 的 chunk 用户能看到——这是 LLM SDK splice 难题的代价。**用户文案内不提**。
- **cooldown 不持久化**：进程重启后 provider 健康状态归零。**接受**：进程重启通常意味着 deploy / crash → 健康的 provider 也会被重新探测。
- **不引入 DB 写入**：**已撤销**——per 用户 2026-09-16 决定，新建 `llm_provider_events` 表存历史轨迹（详见 §8.2 / §8.4）。admin 健康面板 = 内存实时 + DB 历史。

### 7.2 不破坏的约束（per CLAUDE.md / 凭据约束）

- env 命名不变（`ANTHROPIC_*` / `LLM_PROVIDER_2_*`）
- 凭据不入日志（`apiKey` / `baseURL` / prompt / response 全文都不进 `console.info`）
- .env* 仍然 gitignore
- 提交身份仍是 `claudecode@local`
- push 输出脱敏 `sed -E 's#https?://[^@/ ]*@#***@#g'`

### 7.3 单测可行性

- `llm.ts` 当前依赖 `@anthropic-ai/sdk`，SDK 的 `messages.stream` 返回 `Stream<RawMessageStreamEvent>`——vitest mock 起来不复杂（写个 `AsyncIterable` 实现即可）。
- ProviderHealth 是纯函数 + 内存 Map，无 IO，单测极简。
- SSE 容错：构造畸形 event（`{}` / `{type:'content_block_delta'}` 无 delta / `{type:'unknown'}`）走一遍即可。
- **预期**：新增 ~230 行单测，全过。

### 7.4 浏览器手测

| 场景 | 期望 |
|---|---|
| 单 provider（zhipu）正常 | 完全等同现状，无感知 |
| 单 provider（zhipu）流第 1 event 畸形 | 切 provider-2，正常出（需要 env 配 provider-2） |
| 单 provider（zhipu）流中段畸形 | 当前 chunk 容错跳过；后续 chunk 正常 yield；用户无感 |
| 单 provider（zhipu）流 hang 60s | 超时抛错，前端提示「出了点问题，请重试」（重试按钮可用） |
| 双 provider 都挂 | 同上，但 cooldown 后 5 分钟再试 |
| admin（设计稿 2）打开 provider 健康面板 | 看到 zhipu consecutiveFailures / cooldownUntil |

---

## 八、用户决策（2026-09-16 已拍板）

### 8.1 决策清单

| # | 决策 | 实现落点 |
|---|---|---|
| 1 | **cooldown 封顶 5 分钟**，但**留配置项**——不在代码里硬编码，从 `src/lib/llm-config.ts`（新文件）的 `COOLDOWN_MAX_MS` 读，默认 300_000。admin 后台（设计稿 2 §4.4）提供 toggle | `src/lib/llm-config.ts` + admin UI |
| 2 | **onProviderSwitch 接前端**——轻量接：API 层 SSE 流里嵌入 `event: provider_switch` 事件，前端 OnboardingWizard / ChatView 渲染灰色小字「— provider A 异常，已自动切换继续」；**不清空已显示的文本**（避免更糟体感） | 13 个调用点中**流式的 2 个**要写新事件；前端 2 个组件加 listener |
| 3 | **写 DB**——新建表 `llm_provider_events`（结构见 §8.2），每条 provider 调用 / 切换 / 失败都入档。admin 健康面板读它 | `src/lib/db.ts` CREATE TABLE + `src/lib/llm-log.ts` 写表 |
| 4 | **不上 Redis**——本期接受多实例独立 cooldown；每个实例独立 Map | 不动（已确认） |

### 8.2 `llm_provider_events` 表结构

```sql
CREATE TABLE IF NOT EXISTS llm_provider_events (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  provider_id text NOT NULL,             -- 'zhipu' | 'provider-2' | ...
  call_id text NOT NULL,                 -- crypto.randomUUID()，关联同一请求的多条记录
  kind text NOT NULL,                    -- 'start' | 'success' | 'failure' | 'switch' | 'malformed_event' | 'timeout'
  error_kind text,                       -- NULL 或 'server_5xx' | 'stream_throw' | 'config_4xx' | 'timeout' | 'rate_limit'
  duration_ms int,
  chunks_yielded int,                    -- 该次调用已 yield 的 chunk 数（用于「部分失败后切 provider」的量度）
  call_purpose text,                     -- 'onboarding.talk' | 'chat.stream' | 'portrait' | ...（给 admin 诊断用）
  -- 严禁：apiKey / baseURL / prompt / response 全文 / 用户 id（脱敏留 user_key）
  user_key text,                         -- 访客 = 'g:<cookie>'，登录 = 'u:<id>'
  metadata jsonb DEFAULT '{}'::jsonb     -- 扩展位：模型 / maxTokens / 4xx 错误码等
);

CREATE INDEX IF NOT EXISTS idx_llm_pe_provider_ts ON llm_provider_events(provider_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_pe_call ON llm_provider_events(call_id);
CREATE INDEX IF NOT EXISTS idx_llm_pe_kind_ts ON llm_provider_events(kind, ts DESC);
```

**关键约束**（per CLAUDE.md 凭据约束）：
- **不写** `apiKey` / `baseURL` / prompt / response 全文
- `user_key` 是脱敏后值（visitor cookie / user id）——**不进 raw email / username**
- `metadata` jsonb **不允许存** LLM 返回文本

### 8.3 onProviderSwitch 接前端的契约

**后端**（`src/lib/llm.ts` `llmStream()`）：

```ts
// 在 stream 失败切下一个 provider 时，向调用方 yield 一个特殊 marker：
yield { __providerSwitch: { from: id, to: nextId, reason: errorKind, chunksYielded: started ? chunkCount : 0 } } as any;
```

**API 层**（`/api/chat/[sessionId]/route.ts` line 242 + `/api/onboarding/talk/route.ts` line 40）：

```ts
// 把 marker 序列化成 SSE event：
const encoder = new TextEncoder();
const stream = new ReadableStream({
  async start(controller) {
    for await (const chunk of llmStream(opts)) {
      if (typeof chunk === 'string') {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`));
      } else if (chunk && chunk.__providerSwitch) {
        controller.enqueue(encoder.encode(`event: provider_switch\ndata: ${JSON.stringify(chunk.__providerSwitch)}\n\n`));
      }
    }
    controller.close();
  }
});
return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
```

**前端**（`src/components/OnboardingWizard.tsx` + `src/components/ChatView.tsx`）：

```ts
// 在 fetch stream 的 reader 循环里：
const { value } = await reader.read();
const text = new TextDecoder().decode(value);
// text 可能是 "data: {...}\n\n" 或 "event: provider_switch\ndata: {...}\n\n"
if (text.startsWith('event: provider_switch')) {
  // 在当前助手气泡下方加灰色小字：
  setAssistantBubbleMeta((m) => ({ ...m, providerSwitched: true }));
}
```

i18n 4 语新增 `provider.switchedHint: '（provider A 异常，已自动切换继续）'`，en/zh-CN 必填，zh-TW/ja 留 key。

### 8.4 admin 联动（设计稿 2 §4.4 修订）

admin `provider` 列表页"健康"列不再只读 `ProviderHealth.snapshot()`——同时**查 `llm_provider_events` 过去 24h 失败率**：

```sql
-- 实时健康度（内存） + 历史失败率（DB） = admin 一眼能看出"哪个 provider 现在挂 / 历来挂"
SELECT
  provider_id,
  COUNT(*) FILTER (WHERE kind='success') AS success_24h,
  COUNT(*) FILTER (WHERE kind='failure') AS failure_24h,
  MAX(ts) FILTER (WHERE kind='failure') AS last_failure_at
FROM llm_provider_events
WHERE ts > now() - interval '24 hours'
GROUP BY provider_id;
```

### 8.5 改动量更新

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/lib/llm.ts` | 重写 + providerSwitch marker | +130 |
| `src/lib/llm-health.ts` | **新**：ProviderHealth class（5 分钟上限走 `llm-config`） | +90 |
| `src/lib/llm-config.ts` | **新**：COOLDOWN_MAX_MS 等可配常量 | +20 |
| `src/lib/llm-log.ts` | **新**：logProviderEvent + DB 写入 | +60 |
| `src/lib/db.ts` | doMigrate 加 `llm_provider_events` 表 + 3 索引 | +20 |
| `src/app/api/chat/[sessionId]/route.ts` | SSE 流包装（line 242 附近） | +20 |
| `src/app/api/onboarding/talk/route.ts` | SSE 流包装（line 40 附近） | +20 |
| `src/components/OnboardingWizard.tsx` | providerSwitch event listener + i18n meta | +30 |
| `src/components/ChatView.tsx` | 同上 | +30 |
| `src/i18n/messages/{en,zh-CN}.json` | 加 `provider.switchedHint` | +4 |
| `src/tests/llm-failover.test.ts` | **新** | +180 |
| `src/tests/llm-sse-parse.test.ts` | **新** | +80 |
| `src/tests/llm-log.test.ts` | **新**：mock DB 写 `llm_provider_events` | +60 |
| `docs/03 §11` | 修订记录（已加） | — |
| `docs/02 §12` | 产品口径 | +8 |

**总改动**：~740 行（vs 原 460）——多出 280 行主要在 DB 写表 + 前端 SSE 解析 + 新单测。**仍不动 13 个调用点的非流式 11 个**（它们走 `llmComplete` / `llmCompleteJson`，**不 emit** providerSwitch，因为它们本来就全试完才放弃）。

---

## 九、与 docs/kb 的关系

本文档未引用知识库（KB）内容，因为：
- 多 provider failover 是**新增能力**（`docs/` 此前未规划）
- 凭据约束（已写入 CLAUDE.md ⓪）来自 CLAUDE.md 本体，不来自 KB 镜像
- 本设计稿独立可读

涉及"为什么需要 failover"的论据来自 `docs/02 §2`（用户体验设计 — 不能让用户因 provider 故障丢失数据）。

**留痕位置**：`docs/03 §11 修订记录` 加一条 `2026-09-16 · 新增设计稿 docs/design/multi-provider-failover.md`；`docs/08` 不动（不是 bug，是新功能）。