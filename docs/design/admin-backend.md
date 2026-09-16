# 设计稿 · 后台管理页面（v1：用户管理 + provider 管理）

> 状态：**已锁定决策（2026-09-16 用户拍板 6 条），待实施**
> 作者：编码侧 · 2026-09-16
> 触发：用户 2026-09-16 指令「提供一个后台管理的页面，当前先放用户管理和 provider 管理，后续包括内容包管理（app 框架 + 书的内容包）」
> 适用范围：新增 `src/app/[locale]/admin/*` 路由段 + `src/app/api/admin/*` API 段 + 2 张新 DB 表
> 实际改动量：约 1940 行（详见 §5 + §7.1 测试配额）

---

## 一、问题陈述

### 1.1 现状（探索事实）

- **没有 admin 路由**：`src/app/[locale]/` 16 段均无 `admin/`
- **没有 admin API**：`src/app/api/` 33 个 route.ts 均无 admin 标记
- **没有角色机制**：`src/lib/auth.ts`（better-auth 配置）**没有 admin plugin**，`user` 表只有 `changeEmail` 字段，**无 `role` / `isAdmin` 列**
- **`src/lib/identity.ts:resolveIdentity()`**：只判 `userId !== null`，**无 admin 判定**
- **没有 admin UI 痕迹**：`src/components/` 33 个组件无 Nav/Sidebar/Header，**无通用 Table/Form primitive**
- **DB schema 是原生 SQL**：`src/lib/db.ts:67-359` 用 `CREATE TABLE IF NOT EXISTS` + `doMigrate`，**不是 drizzle**
- **provider 配置**：全 env，**无 DB 持久化**

### 1.2 用户原始诉求

> 「先放用户管理和 provider 管理，后续包括内容包管理（app 框架 + 书的内容包）」

拆解：
- **v1（本期）**：用户管理 + provider 管理
- **v2（未来）**：内容包管理——"app 框架 + 书的内容包"。这是**新概念**，可能是 stage 配置 / 实验模板 / 推送节奏模板。**本设计稿只留接口位**，不实现。

---

## 二、设计目标 & 非目标

### 2.1 目标（v1）

1. **admin 路由** `/[locale]/admin`：**仅 admin 角色可访问**，其他身份 302 回首页 + 401 API 拒绝
2. **角色机制**：扩展 `user` 表加 `role` 列（默认 `'user'`，可 `'admin'`）。**不引入 better-auth admin plugin**（避免依赖扩张），用我们自己的 `isAdmin()` 工具函数读 custom field。
3. **admin nav 入口**：仅 admin 角色在 `[locale]/me` 页底部看到一个 "管理后台" 链接（不进主 nav，避免对普通用户暴露 admin 的存在）
4. **用户管理**：
   - 列表（分页、搜索 email/username）
   - 详情（基础信息：email / username / createdAt / role / 当前 portrait 摘要 / 最近 chat session / 订阅状态）
   - 角色变更（admin ↔ user）+ **操作要二次确认**（per CLAUDE.md 凭据约束）
5. **provider 管理**：
   - 列表（从 `getLlmProviders()` 实时读；显示 label / id / 当前 cooldown 状态 / 最近 24h 失败率）
   - **CRUD 配置**：增 / 改 / 删 / 启停 provider 配置（DB 持久化 + env fallback）
   - **健康状态只读**：来自 `ProviderHealth.snapshot()`（设计稿 1 §4.2）

### 2.2 非目标（v1 不做）

- ❌ 内容包管理（v2 范畴）
- ❌ 审计日志 / 操作历史（先 console，v2 接 DB）
- ❌ 细粒度权限（admin / user 二元即可）
- ❌ 多 admin / 子角色 / 部门
- ❌ 操作撤销（角色变更 / provider 删除不可撤销，**二次确认 + DB backup 前置**）
- ❌ dashboard / 数据可视化（v2）
- ❌ admin 端的消息推送 / 触达（v2）
- ❌ admin 端的 LLM 调试台（v2）

### 2.3 不破坏的约束

- 凭据敏感（apiKey 不回显 / 不入日志）
- 不动 better-auth 默认 user 表结构（`role` 列通过 `doMigrate` ALTER ADD COLUMN 加，**默认值 `'user'`**）
- 不动现有 16 个用户路由 + 33 个 API 路由
- 不引入新依赖（用现有 better-auth / drizzle-free 原生 SQL / Next.js 自带）
- i18n 4 语（en/zh-CN/zh-TW/ja），admin 走 `enabledLocales = ['en','zh-CN']`
- 提交身份 `claudecode@local` / `sed -E 's#https?://[^@/ ]*@#***@#g'` push 脱敏

---

## 三、核心设计

### 3.1 角色模型

#### 3.1.1 user 表加 `role` 列

```sql
-- src/lib/db.ts doMigrate 内追加
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'user';
```

`role` 取值：`'user' | 'admin'`（本期二元，**不加 CHECK 约束**，给未来扩展留空间）。

#### 3.1.2 工具函数

```ts
// src/lib/auth.ts 末尾
export function isAdmin(userId: string | null): boolean {
  if (!userId) return false;
  // 缓存 5s 避免每个请求都查 DB
  return adminCache.get(userId) ?? loadAdminFromDb(userId);
}
```

```ts
// src/lib/identity.ts 扩展
export interface RequestIdentity {
  key: string;
  userId: string | null;
  newGuestCookie: string | null;
  isAdmin: boolean;  // ← 新增
}
```

`resolveIdentity()` 在 userId != null 时调用 `isAdmin()` 注入。

#### 3.1.3 admin 入口策略

| 身份 | `/admin` 页面 | `/api/admin/*` | `[locale]/me` 上的 admin 链接 |
|---|---|---|---|
| 访客（userId=null） | 302 → `/` | 401 | 不渲染 |
| user（非 admin） | 302 → `/` | 401 | 不渲染 |
| admin | 200 | 200 | 渲染"管理后台"链接 → `/admin` |

### 3.2 路由结构

```
src/app/[locale]/admin/
  layout.tsx              # admin shell：左侧 nav + 右侧内容
  page.tsx                # admin 首页：摘要卡片（用户数 / 在线 provider 数 / 待办）
  users/
    page.tsx              # 用户列表（分页 50/page，搜索）
    [id]/page.tsx         # 用户详情
  providers/
    page.tsx              # provider 列表 + 健康状态
    new/page.tsx          # 新增 provider
    [id]/page.tsx         # 编辑 provider + 启停 / 删除
  content/                # v2 占位：本期只渲染 "Coming soon"
    page.tsx
```

```
src/app/api/admin/
  users/
    route.ts              # GET 列表（query: page, search）
    [id]/route.ts         # GET 详情 / PATCH 角色
  providers/
    route.ts              # GET 列表 / POST 新增
    [id]/route.ts         # GET / PATCH / DELETE
    [id]/test/route.ts    # POST：触发一次 ping（不计入 provider 健康）
  health/route.ts         # GET：ProviderHealth.snapshot()
```

### 3.3 DB 表设计

#### 3.3.1 provider 配置表（新增）

```sql
-- src/lib/db.ts doMigrate 内追加
CREATE TABLE IF NOT EXISTS llm_providers (
  id text PRIMARY KEY,                  -- 'provider-3' 自定义，或 'zhipu' / 'provider-2' 覆盖 env
  label text NOT NULL,
  base_url text NOT NULL,
  model text NOT NULL,
  auth_token_encrypted text NOT NULL,   -- 见 §3.3.2 加密
  is_enabled boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 100,    -- 越小越优先；env provider 优先级 0 / 10
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text                       -- admin user id
);

CREATE INDEX IF NOT EXISTS idx_llm_providers_enabled ON llm_providers(is_enabled, priority);
```

#### 3.3.2 auth_token 加密

不存明文。用项目已有的 **`RECOVERY_PEPPER`** env 作为对称加密密钥（AES-256-GCM）：

```ts
// src/lib/crypto.ts (新文件，但 RECOVERY_PEPPER 现成可用)
export function encryptSecret(plain: string): string {
  // AES-256-GCM(plain, key=hash(RECOVERY_PEPPER), iv=random)
  // 输出 base64: <iv>:<ciphertext>:<authTag>
}
export function decryptSecret(enc: string): string { ... }
```

**约束**：`RECOVERY_PEPPER` 必须存在（项目已经在用，没它是 deploy 错误）。**admin UI 不回显 token**——只显示「已配置 / 未配置」标记 + 一个「测试连接」按钮（§3.5）。

#### 3.3.3 getLlmProviders() 改造

```ts
// src/lib/llm.ts:18-43
export function getLlmProviders(): LlmProvider[] {
  const envProviders = readEnvProviders();  // 现状
  const dbProviders = readDbProviders();    // 新增
  // env 优先（不可被 DB 覆盖——避免 DB 误改导致 zhipu 主 provider 失效）
  // DB provider 用 'provider-3' / 'provider-4' ... id 起步，priority 100+
  return [...envProviders, ...dbProviders].sort(byPriorityThenId);
}
```

**关键决策**：env 是「不可覆盖的基线」，DB 是「扩展」。删 DB provider 不影响 env；admin 不能通过 DB 把 zhipu 改成别的 baseURL——**baseURL 锁定在 env**。

> 这是 v1 简化：**admin 能做的事 = 加新 provider / 调优先级 / 启停**。**改 zhipu baseURL 要走代码 + 重新部署**（这是有意的——LLM 配置错误是 P0 故障，不能 admin 后台一键改坏）。

### 3.4 用户管理 UI

#### 3.4.1 列表 `/admin/users`

| 列 | 来源 | 可排序 |
|---|---|---|
| email | `user.email` | ✓ |
| username | `user.username` | ✓ |
| role | `user.role` | ✓ |
| created_at | `user.createdAt` | ✓ |
| portrait_stage | `growth_profiles.stage`（LEFT JOIN） | ✗ |
| 最近 chat | `MAX(chat_sessions.created_at)`（子查询） | ✓ |
| 订阅状态 | `subscriptions.status`（LEFT JOIN） | ✗ |

搜索框：`email ILIKE '%q%' OR username ILIKE '%q%'`。

分页：`?page=1&pageSize=50`（pageSize 上限 200）。

#### 3.4.2 详情 `/admin/users/[id]`

```
┌─────────────────────────────────────────────┐
│ user@example.com           [admin] [user]    │ ← 角色徽章 + 切换按钮（弹确认 modal）
├─────────────────────────────────────────────┤
│ 基本：                                      │
│   username: hermes_demo                     │
│   created: 2026-09-01 12:34                 │
│   emailVerified: ✓                          │
├─────────────────────────────────────────────┤
│ 当前 portrait（from growth_profiles）：       │
│   stage: 萌芽期                              │
│   stage_started_at: 2026-09-10              │
│   三个瞬间: [...]                            │
│   ...                                        │
├─────────────────────────────────────────────┤
│ 最近 5 个 chat session（from chat_sessions） │
│   ...                                        │
├─────────────────────────────────────────────┤
│ 订阅状态（from subscriptions）                │
│   provider: creem | status: active | ...    │
├─────────────────────────────────────────────┤
│ [切换角色]   [查看导出]   [危险操作 ▼]        │ ← 折叠：删账号（要确认两次）
└─────────────────────────────────────────────┘
```

**「切换角色」按钮** → modal：「确认把 user@example.com 改成 admin？他将能访问 /admin」→ 二次确认（输入 email 前 3 个字符）。

**「危险操作」折叠**：v1 **只渲染提示文字**「删账号功能待 v2 提供（避免误删），临时需要请走 DB」。

#### 3.4.3 头像 / 名片 / 通知：v1 不做

### 3.5 provider 管理 UI

#### 3.5.1 列表 `/admin/providers`

| 列 | 来源 | 说明 |
|---|---|---|
| id | LlmProvider.id | |
| label | LlmProvider.label | |
| source | env / db | **环境变量 / 数据库**（env 的不能改） |
| enabled | is_enabled | toggle 按钮（仅 db） |
| 优先级 | priority | 数字（仅 db 可调） |
| 健康 | ProviderHealth.snapshot() | 绿（enabled）/ 黄（cooldown 中）/ 红（连续失败） |

绿色 = `enabled && !cooldown && consecutiveFailures < 1`
黄色 = `enabled && (cooldown || 1 <= consecutiveFailures < 3)`
红色 = `!enabled || consecutiveFailures >= 3`

#### 3.5.2 新增 `/admin/providers/new`

表单：
- `id`（必填，pattern `^[a-z][a-z0-9-]{1,30}$`，**不能与 env provider id 冲突**）
- `label`
- `base_url`
- `model`
- `auth_token`（password input，提交时加密入 DB；**不存明文**）
- `priority`（默认 100）
- `is_enabled`（默认 true）

提交 → 写 `llm_providers` → 跳详情页。

#### 3.5.3 详情 `/admin/providers/[id]`

```
┌─────────────────────────────────────────────┐
│ provider-3 (LLM Provider)                    │
│ 来源：db · 优先级 100 · enabled ✓            │
├─────────────────────────────────────────────┤
│ base_url: https://api.example.com            │
│ model: claude-haiku-4-5                      │
│ auth_token: ●●●●●●●●●●  (已配置) [测试连接]   │
├─────────────────────────────────────────────┤
│ 健康：cooldownUntil=null, consecutiveFailures=0│
│                                             │
│ [保存修改] [启停] [删除]                     │
└─────────────────────────────────────────────┘
```

**「测试连接」按钮**：POST `/api/admin/providers/[id]/test` → 跑一次 `messages.create({ max_tokens: 1 })`，返回 `{ ok: true, latencyMs }` 或 `{ ok: false, error: '...' }`。**不计入 ProviderHealth**（设计稿 1 §4.2 的 health）——避免 admin 的测试污染真实健康状态。

#### 3.5.4 启停 / 删除

- 启停：PATCH `is_enabled`。
- 删除：DELETE → 弹确认 modal（输入 id 前 3 字符）→ **真删**（不留 audit log）。

### 3.6 API 路由契约

#### 3.6.1 通用约束

```ts
// 每个 admin route.ts 头三行：
const identity = await resolveIdentity({ headers, cookies });
if (!identity.isAdmin) {
  return Response.json({ error: 'unauthorized', reason: 'admin_required' }, { status: 401 });
}
```

封装到 `src/lib/admin-gate.ts`：

```ts
export async function requireAdmin(req: Request): Promise<RequestIdentity> {
  const identity = await resolveIdentity({ headers: req.headers, cookies: cookieHeader(req) });
  if (!identity.isAdmin) {
    throw Response.json({ error: 'unauthorized', reason: 'admin_required' }, { status: 401 });
  }
  return identity;
}
```

每个 admin route 一行 `const identity = await requireAdmin(req);`。

#### 3.6.2 用户列表

```http
GET /api/admin/users?page=1&pageSize=50&search=hermes
```

返回：
```json
{
  "users": [
    {
      "id": "uuid",
      "email": "hermes@example.com",
      "username": "hermes_demo",
      "role": "user",
      "createdAt": "2026-09-01T...",
      "portraitStage": "萌芽期",
      "lastChatAt": "2026-09-15T...",
      "subscriptionStatus": "active"
    }
  ],
  "page": 1,
  "pageSize": 50,
  "total": 123
}
```

#### 3.6.3 切换用户角色

```http
PATCH /api/admin/users/[id]
Content-Type: application/json
{ "role": "admin" }
```

返回：200 + 更新后的 user。**没有 audit log**（v2 接）。

#### 3.6.4 provider 列表 / CRUD

```http
GET    /api/admin/providers          → 合并 env + db
POST   /api/admin/providers          → body: {id, label, base_url, model, auth_token, priority?, is_enabled?}
GET    /api/admin/providers/[id]     → 单个
PATCH  /api/admin/providers/[id]     → body: {label?, base_url?, model?, auth_token?, priority?, is_enabled?}
DELETE /api/admin/providers/[id]     → 204
POST   /api/admin/providers/[id]/test → {ok, latencyMs, error?}
```

**所有 response 绝不回显 `auth_token` / `auth_token_encrypted` 字段**——只回 `"authTokenConfigured": true`。

### 3.7 i18n

admin 用现有 4 语 messages，在 `src/i18n/messages/{en,zh-CN}.json` 加 `admin.*` 命名空间：

```json
{
  "admin": {
    "nav": { "users": "Users", "providers": "Providers", "content": "Content (v2)" },
    "users": {
      "title": "User Management",
      "search": "Search by email or username",
      "columns": { "email": "Email", "role": "Role", "createdAt": "Created", "stage": "Stage" },
      "actions": { "changeRole": "Change Role", "confirmChangeRole": "Confirm changing {email} to {role}?" }
    },
    "providers": {
      "title": "LLM Providers",
      "health": { "healthy": "Healthy", "degraded": "Degraded", "down": "Down" },
      "actions": { "test": "Test Connection", "delete": "Delete", "deleteConfirm": "Type the first 3 chars of provider id to confirm" }
    }
  }
}
```

en / zh-CN v1 必填；zh-TW / ja v1 留 key 留空字符串，**不强制翻译**（per 用户 2026-09-16 决定：admin 内部工具，仅 en/zh-CN）。

---

## 四、admin 与设计稿 1 的接口

设计稿 1 的 `ProviderHealth.snapshot()` 已经是 admin 健康面板的数据源。admin 路由读它即可。

**反方向**：admin 改 provider 后 → `getLlmProviders()` 重新读 DB → 下次 LLM 调用立即生效。**不需要重启进程**——这是 v1 必须的，否则 admin 改了等于没改。

```ts
// src/lib/llm.ts:18 新增：每次 getLlmProviders() 调用都重读 DB
export function getLlmProviders(): LlmProvider[] {
  // ... 现状 env 读 + 新增 DB 读（每次调用都读，简单；如需缓存可后续加 5s TTL）
}
```

> 性能权衡：每个 LLM 调用多 1 次 DB SELECT——**可接受**（llm 调用本身 1-3s，DB query 5ms）。v1 不做缓存。

---

## 五、改动文件清单

| 文件 | 改动 | 行数估算 |
|---|---|---|
| `src/lib/db.ts` | doMigrate 加 ALTER user.role / CREATE llm_providers | +20 |
| `src/lib/auth.ts` | 加 isAdmin() + adminCache | +30 |
| `src/lib/identity.ts` | RequestIdentity.isAdmin + resolveIdentity 注入 | +10 |
| `src/lib/admin-gate.ts` | **新文件**：requireAdmin() | +20 |
| `src/lib/admin-test-quota.ts` | **新文件**：checkAndIncrementTestQuota() 内存 Map（per 用户 2026-09-16 决定） | +30 |
| `src/lib/crypto.ts` | **新文件**：encryptSecret/decryptSecret（AES-256-GCM） | +60 |
| `src/lib/llm.ts` | getLlmProviders() 读 DB；LlmProvider.authHeader 改成加密字段 | +20 |
| `src/app/[locale]/admin/layout.tsx` | **新文件** | +80 |
| `src/app/[locale]/admin/page.tsx` | **新文件** | +60 |
| `src/app/[locale]/admin/users/page.tsx` | **新文件** | +200 |
| `src/app/[locale]/admin/users/[id]/page.tsx` | **新文件** | +150 |
| `src/app/[locale]/admin/providers/page.tsx` | **新文件** | +200 |
| `src/app/[locale]/admin/providers/new/page.tsx` | **新文件** | +150 |
| `src/app/[locale]/admin/providers/[id]/page.tsx` | **新文件** | +200 |
| `src/app/[locale]/admin/content/page.tsx` | **新文件**（v2 占位） | +20 |
| `src/app/[locale]/me/page.tsx` | 加 admin 链接（条件渲染） | +10 |
| `src/app/api/admin/users/route.ts` | **新文件** | +60 |
| `src/app/api/admin/users/[id]/route.ts` | **新文件** | +80 |
| `src/app/api/admin/providers/route.ts` | **新文件** | +100 |
| `src/app/api/admin/providers/[id]/route.ts` | **新文件** | +120 |
| `src/app/api/admin/providers/[id]/test/route.ts` | **新文件** | +60 |
| `src/app/api/admin/health/route.ts` | **新文件** | +30 |
| `src/i18n/messages/{en,zh-CN}.json` | 加 admin.* 命名空间（zh-TW/ja 留 key 不填） | +80 × 2 |
| `src/tests/admin-gate.test.ts` | **新文件** | +60 |
| `src/tests/admin-providers.test.ts` | **新文件**：DB CRUD | +100 |
| `src/tests/crypto.test.ts` | **新文件** | +50 |
| `src/tests/admin-test-quota.test.ts` | **新文件**：日限 100 / 跨日 / 重启 | +40 |
| `docs/03 §11` | 修订记录 | +15 |
| `docs/02 §12` | 产品口径 | +8 |
| `docs/08` | 不动 | — |

**总改动**：约 19 个新文件 + 6 个修改 + 2 个文档，约 **1940 行**。

---

## 六、风险与约束

### 6.1 已知取捨

- **user.role 列不做 CHECK 约束**：未来扩展空间（`'admin' | 'editor' | '...' | 'user'`）——v1 仅 enum 用 `'user' | 'admin'`。
- **provider 配置 DB 部分无 audit log**：v1 console.info 即可；v2 加 `admin_audit_log` 表。
- **admin 不能改 env provider 的 baseURL**：v1 简化；v2 引入"env override with 强制 2-step 确认"。
- **admin 改 provider 不需重启**：实时生效 = 优点（admin 体验好）+ 风险（改错立刻影响线上）——通过"启停"步骤缓冲（先 is_enabled=false 观察，再改）。

### 6.2 安全

- **role 列不能通过 GraphQL/REST 注入**：better-auth 默认 user 表我们不直接 PATCH，`PATCH /api/admin/users/[id]` 是我们自建路由，自己校验。
- **auth_token 不回显**：服务端 encryptSecret 入库，响应永远 `authTokenConfigured: boolean`。
- **RECOVERY_PEPPER 不能丢**：deploy 时校验（`scripts/check-env.mjs` 加一条）。
- **admin 路由 cookie 隔离**：现有 cookie 机制即可（无 cross-domain admin 子域）。
- **不在 admin UI 中暴露 provider id 真实服务地址**：base_url 显示但加提示"含敏感域名，请勿截屏外传"。

### 6.3 浏览器手测

| 场景 | 期望 |
|---|---|
| 访客访问 `/admin` | 302 → `/` |
| user 访问 `/admin` | 302 → `/` |
| admin 访问 `/admin` | 200，看到 admin shell |
| admin 列表点用户 | 进详情，看到 portrait / chat / 订阅摘要 |
| admin 切换用户角色 | 二次确认 modal → 确认 → DB 写入 |
| admin 新增 provider | 表单填全 → 提交 → 跳详情 → 测试连接 → "ok" |
| admin 测试连接一个错配的 provider | 返回 `{ok: false, error: '401 unauthorized'}` |
| admin 删 provider | 二次确认 modal → 确认 → DB 行消失 → `getLlmProviders()` 下次调用不带它 |
| 普通 user 进 `[locale]/me` | 看不到"管理后台"链接 |

### 6.4 与 docs/kb 的关系

本文档未引用 KB 镜像内容，因为：
- admin 后台是**全新功能**（KB 此前未规划用户 / provider 管理 UI）
- i18n / 安全约束来自 CLAUDE.md 本体

涉及"为什么需要 admin"的论据来自：
- `docs/02 §5`（运营视角——需要看用户 + 改 provider 的能力）
- `docs/04 M8 Go-No-Go`（上线前必须有 admin 路径调 provider）

**留痕位置**：`docs/03 §11 修订记录` 加一条 `2026-09-16 · 新增设计稿 docs/design/admin-backend.md`；`docs/08` 不动。

---

## 七、用户决策（2026-09-16 已拍板）

| # | 决策 | 实现落点 |
|---|---|---|
| 1 | **首批 admin 手工建**：用户自己用 better-auth 注册一个账号，然后**手工跑 SQL** `UPDATE "user" SET role='admin' WHERE email='your@email'`。`docs/08` 留一条 P-1 提醒部署后必做 | 文档留痕；无代码 |
| 2 | **provider 优先级 UI = 列表显示 + 手动输入确认**：在 `/admin/providers` 列表页右侧加一列 `priority`（数字），点击进入编辑 modal。**无拖拽**——避免无意义的状态管理 | 列表页 + 简单 modal |
| 3 | **provider 测试连接日限 100 次**：每个 admin 每天最多 100 次 `/api/admin/providers/[id]/test`。**实现**：内存 Map `<adminId, { day, count }>` + DB fallback（防进程重启丢计数）—— DB 表复用 `llm_provider_events`，加 `kind='admin_test'` 计数 | 新增 `provider_test_quota` 内存 Map（5 行） + 利用 `llm_provider_events` 持久计数 |
| 4 | **删账号按钮置灰**：v1 不实现，只渲染灰色按钮 + tooltip "v2 提供"。**理由**：删账号牵涉 portrait/journal/chat/subscription 4 张表级联，留 v2 做 | UI 占位 |
| 5 | **admin URL `/admin` 不隐藏**：方便你调试，**后续可隐藏**——v2 加 `ADMIN_URL_PREFIX` env（如 `ADMIN_URL_PREFIX=/studio-2026` → 路由 `/[locale]/studio-2026/...`） | v1 直 `/admin`；v2 env 改名 |
| 6 | **admin i18n en/zh-CN**：zh-TW/ja 留 key 不填 | i18n 文件只动 en/zh-CN |

### 7.1 测试连接日限的实现细节

**内存 Map**（`src/lib/admin-test-quota.ts` 新文件，~30 行）：

```ts
const quotas = new Map<string, { day: string; count: number }>();

export function checkAndIncrementTestQuota(adminId: string): { ok: true } | { ok: false; reason: 'daily_limit' } {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const cur = quotas.get(adminId);
  if (!cur || cur.day !== today) {
    quotas.set(adminId, { day: today, count: 1 });
    return { ok: true };
  }
  if (cur.count >= 100) {
    return { ok: false, reason: 'daily_limit' };
  }
  cur.count++;
  return { ok: true };
}
```

**DB 持久计数**（防进程重启）：在 `llm_provider_events` 表里加 `kind='admin_test'` 记录，admin 路由首句 SELECT 计数——但**双写有竞争**，所以**内存优先 + DB 兜底每周一次 reconcile**——本期**不实现 reconcile**（"日限"允许进程重启后重新计数，**接受**：admin 一天 100 次足够）。

**响应**：

```ts
if (!quota.ok) {
  return Response.json({ error: 'rate_limited', reason: 'admin_test_daily_limit', limit: 100 }, { status: 429 });
}
```

### 7.2 优先级 UI 草图

`/admin/providers` 列表页右侧 `priority` 列：

```
┌──────────────────────────────────────────────────────┐
│ id          │ label      │ source │ enabled │ priority │
├──────────────────────────────────────────────────────┤
│ zhipu       │ 智谱 glm   │ env    │ ✓       │ 0 (env)  │  ← 不可改
│ provider-2  │ 备用 LLM 1 │ env    │ ✓       │ 10 (env) │  ← 不可改
│ provider-3  │ 自加 Anthropic │ db │ ✓       │ 100 [编辑]│
└──────────────────────────────────────────────────────┘
```

点 `[编辑]` 弹 modal：

```
┌──────────────────────────────────────┐
│ 修改 provider-3 的优先级              │
│                                      │
│ 当前：100                             │
│ 新值：[____] (1-999)                 │
│                                      │
│ [取消]              [确认保存]        │
└──────────────────────────────────────┘
```

PATCH `/api/admin/providers/[id]` `body: { priority: 50 }`——不调 LLM 测试，**立即生效**（下次 `getLlmProviders()` 按 priority 重排）。

### 7.3 admin URL v2 隐藏路径的实现（提前占位）

`src/app/[locale]/admin/` → v2 改名 `src/app/[locale]/${process.env.ADMIN_URL_PREFIX ?? 'admin'}/`。**本期实现**：

```ts
// src/app/[locale]/admin/page.tsx 顶部
const urlPrefix = process.env.ADMIN_URL_PREFIX ?? 'admin';
// v1 不读这个 env（直接 hardcode 'admin'），但代码留位
// v2 改 route segment 文件夹名 = admin 改前缀
```

**为啥 v1 不读 env**：env 改了 → `src/app/[locale]/admin/` 文件夹不存在 → 404。**真正的 env 化 = 文件夹改名 = deploy**。v1 不浪费这个口子，v2 真要时改一次文件夹。

---

## 八、内容包管理（v2 占位）

按你原话「后续包括内容包管理（app 框架 + 书的内容包）」，本设计稿**只占位不实现**：

- `/admin/content/page.tsx` 渲染 "Content Packs — coming in v2" + 一个 form 草稿（disabled 状态）：
  - pack id / 名称 / 适用 stage / payload (JSON) / priority
- 不建表，不存数据
- 留 `src/lib/content-pack.ts` 文件但只 export `interface ContentPack` 类型

**为什么这么早占位**：admin shell nav 要预留 tab，否则 v1 admin 上线后再加 content tab 要重新发版。**提前占位 = admin shell 一次定型，v2 只填内容**。

v2 真实设计稿（何时做未定）要回答的问题：
- "app 框架" = stage 配置？实验模板？触达节奏？
- "书的内容包" = 单本书的 metadata + LLM prompt 模板？
- 内容包与 `growth_profiles.books` 字段的关系？
- 多书切换是 per-user 还是 per-stage？

**这些都不在本设计稿范围**——你说"后续"我理解为 v2。