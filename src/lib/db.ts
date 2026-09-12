import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { getDbProviders } from '@/config/db-providers';

/**
 * Neon Postgres 业务数据层入口（订阅/权益/配额表）。
 *
 * 双驱动分工（与认证层 lib/auth.ts 配合）：
 * - 本文件用 @neondatabase/serverless 的 HTTP 驱动（无长连接、参数化查询防注入），
 *   适合 serverless/无状态的业务查询
 * - 认证表（"user"/"session"/"account"/"verification"）由 better-auth 经 pg Pool
 *   管理（TCP 长连接池），建表走 scripts/schema-migrate.mjs
 *
 * 故障切换：getSql() 走 getDbProviders() 第 1 项（pooled）。运行时 SQL 失败
 * 由 execWithFailover 捕获并切换到下一项 URL 重建 client 重试。
 * neon() 构造是惰性的（不真发请求），所以在循环里重建 client 是安全的。
 */

// <false, false>：数组行、非 fullResults，让调用方拿到 Record<string, any>[]
export type SqlClient = NeonQueryFunction<false, false>;

/**
 * Neon HTTP 驱动把 timestamptz 解析成 JS Date——直接 String() 会得到
 * "Fri Sep 11 2026 ..." 这类无法回代 SQL、也没法 slice(0,10) 做日粒度的串。
 * 所有行映射里的时间戳一律走这里，统一转成 ISO 字符串。
 */
export function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

// 单例 cache：避免每次请求都重建 client。仅在 provider URL 切换时失效。
let cachedUrl: string | null = null;
let cachedClient: SqlClient | null = null;

export function getSql(): SqlClient {
  const providers = getDbProviders();
  if (providers.length === 0) {
    throw new Error('未配置任何 DB 连接串（设置 DATABASE_URL 或 DATABASE_URL_FALLBACK）');
  }
  // 取首项 URL；首项不可用时上层 caller（execWithFailover）会捕获并切下一个
  const url = providers[0].url;
  if (cachedClient && cachedUrl === url) return cachedClient;
  cachedUrl = url;
  cachedClient = neon(url);
  return cachedClient;
}

// 清空单例缓存，让下次 getSql() 重建到新 provider 的 client。
// 切换 provider URL 后调用，避免 client 仍持有旧 URL 句柄。
export function _resetSqlCache(): void {
  cachedClient = null;
  cachedUrl = null;
}

/**
 * 建表（幂等）。模块级 promise 缓存：进程内只执行一次，
 * 首个触碰数据库的请求惰性触发，部署无需单独迁移步骤。
 *
 * ⚠️ 认证四表（"user"/"session"/"account"/"verification"）不在这里建：
 * 由 better-auth 的迁移管理，新库先跑 `node --env-file=.env.local scripts/schema-migrate.mjs`。
 */
let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    // 失败后把缓存置空，下次请求可重试（比如网络抖动）
    schemaReady = doMigrate().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function doMigrate(): Promise<void> {
  const sql = getSql();

  // 订阅权益（多平台通用设计，两张表职责分离）：
  //   subscriptions：平台侧订阅状态（一行一条订阅，provider 区分平台，可多平台并存）
  //   entitlements：站内权益快速判定（一行一个用户，isVip = vip_until > now()）
  // vip_until 由权益引擎（lib/payments/engine.ts）在每次支付事件后"重算"：
  // 该用户所有 live/grace 订阅的 current_period_end 最大值。webhook 丢失时
  // 到期自然失效（自愈），续费事件再延长。
  await sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_customer_id TEXT,
      provider_subscription_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'live',
      provider_status TEXT,
      -- will_cancel / period_end_estimated 可空：NULL = 事件未声明，
      -- upsert 的 DO UPDATE 分支用它做"保留旧值"的哨兵
      will_cancel BOOLEAN DEFAULT false,
      current_period_end TIMESTAMPTZ,
      period_end_estimated BOOLEAN DEFAULT false,
      product_id TEXT,
      price_cents INT,
      currency TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_subscription_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id)`;
  // webhook 只带 customer_id 时反查用户
  await sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(provider, provider_customer_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS entitlements (
      user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      vip_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // 使用量配额：每次"消耗一个单位"（开局/一次生成/一次导出……由 kind 区分）
  // 插一行，按 (user_id | guest_key, day) 计数。day 是 UTC 日期字符串
  // （YYYY-MM-DD）：与服务器无状态依赖、简洁可索引；代价是按东八区"每天"
  // 会有一小时偏移（UTC 0 点 = 北京 8 点），产品上可接受的已知取舍。
  // user_id 可空：游客按 guest_key（IP+日哈希）计数，登录后即按 user_id 计。
  await sql`
    CREATE TABLE IF NOT EXISTS quota_events (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
      guest_key TEXT NOT NULL DEFAULT '',
      day TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'default',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_quota_events_user_day ON quota_events(user_id, day)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_quota_events_guest_day ON quota_events(guest_key, day)`;

  // ---- money-freedom-living 业务表（docs/03 §3）----

  // 成长档案：一行一用户，JSON 字段整体读写（单用户并发极低，读-改-写可接受）。
  // user_key 前缀 u:/g:（identity.ts），游客 key 不 FK —— 注册迁移时整体换键，
  // 删除账号在应用层级联（M7 导出/删除），所以这里不设 REFERENCES。
  await sql`
    CREATE TABLE IF NOT EXISTS growth_profiles (
      user_key TEXT PRIMARY KEY,
      locale TEXT NOT NULL DEFAULT 'en',
      portrait JSONB,
      concerns JSONB NOT NULL DEFAULT '[]',
      stage SMALLINT NOT NULL DEFAULT 1,
      stage_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      pinned JSONB NOT NULL DEFAULT '[]',
      memories JSONB NOT NULL DEFAULT '[]',
      daily_seen JSONB NOT NULL DEFAULT '[]',
      experiments JSONB NOT NULL DEFAULT '[]',
      letters JSONB NOT NULL DEFAULT '[]',
      stamps JSONB NOT NULL DEFAULT '[]',
      payday JSONB,
      recovery_code_hash TEXT,
      total_active_days INT NOT NULL DEFAULT 0,
      last_active_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // 对话会话：kind 区分正式对话与体检初谈；quota_consumed 支撑"首回复成功才落账"（P§7）；
  // safety_flagged 命中危机后置位，后续轮次注入"稳定陪伴模式"（docs/03 §6）
  await sql`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id UUID PRIMARY KEY,
      user_key TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'en',
      kind TEXT NOT NULL DEFAULT 'chat',
      message_count INT NOT NULL DEFAULT 0,
      quota_consumed BOOLEAN NOT NULL DEFAULT false,
      safety_flagged BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // 存量库补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）
  await sql`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS safety_flagged BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE growth_profiles ADD COLUMN IF NOT EXISTS daily_seen JSONB NOT NULL DEFAULT '[]'`;
  // 会话关闭时刻：历史列表按"那天的那次对话"排序用；存量 closed 行为 NULL，读侧 COALESCE(closed_at, created_at)
  await sql`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`;
  // 画像演进状态（dismissedAt/lastGeneratedAt/proposedSeenAt/generatingAt）。
  // 不放 portrait JSONB——calibrate 的 savePortrait 整体覆盖会把它抹掉
  await sql`ALTER TABLE growth_profiles ADD COLUMN IF NOT EXISTS portrait_evolution JSONB NOT NULL DEFAULT '{}'`;
  // 阶段评估状态（pending/confirmed/confirmedAt/dismissedAt/generatingAt/proposedSeenAt）。
  // 同样不放 portrait JSONB（同上）；在 growth_profiles 行内 → 导出/删除/游客迁移级联天然覆盖
  await sql`ALTER TABLE growth_profiles ADD COLUMN IF NOT EXISTS stage_assessment JSONB NOT NULL DEFAULT '{}'`;
  await sql`CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_key, created_at DESC)`;

  // 对话原文只存这里（用户可删）；日志/safety_events 不含原文（P§9 日志纪律）
  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id)`;

  // 安全事件（docs/03 §3）：只存引用与类别，不存原文（P§9 日志纪律）。
  // handled = 是否已向用户呈现转介；删除账号时应用层级联清理（M7）。
  await sql`
    CREATE TABLE IF NOT EXISTS safety_events (
      id BIGSERIAL PRIMARY KEY,
      user_key TEXT NOT NULL,
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      handled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_safety_events_user ON safety_events(user_key, created_at DESC)`;

  // 日记（docs/03 §3）：免费写/存，VIP AI 回应（付费墙②"写完想被回应时"）。
  // 原文只存此处（用户可删）；safety_events 不含原文（P§9 日志纪律）
  await sql`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id BIGSERIAL PRIMARY KEY,
      user_key TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'en',
      content TEXT NOT NULL,
      safety_hit BOOLEAN NOT NULL DEFAULT false,
      ai_reply TEXT,
      replied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_journal_entries_user ON journal_entries(user_key, created_at DESC)`;

  // 画像版本快照（docs/02「画像不是一次性的」）：收录所有版本含当前版；
  // growth_profiles.portrait 是当前版的反规范化副本。UNIQUE 保证懒回填/并发演进幂等。
  // 原文快照属于用户内容：导出/删除/游客迁移三处级联必须同步（M9）。
  await sql`
    CREATE TABLE IF NOT EXISTS portrait_versions (
      id BIGSERIAL PRIMARY KEY,
      user_key TEXT NOT NULL,
      version INT NOT NULL,
      portrait JSONB NOT NULL,
      source TEXT NOT NULL,               -- 'onboarding' | 'evolve' | 'backfill'
      material JSONB NOT NULL DEFAULT '{}', -- 该版基于多少新素材 {memories, journals, experiments, daysSince}
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_key, version)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_portrait_versions_user ON portrait_versions(user_key, version DESC)`;

  // 使用事件（docs/02 §11 验收指标）：只存匿名 user_key + 事件名 + 脱敏元数据，
  // 不存任何用户文本原文（P§9 日志纪律）。user_key 本身不含 PII（u:<uuid>/g:<随机 hex>）。
  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      user_key TEXT NOT NULL,
      name TEXT NOT NULL,
      locale TEXT,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_key, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, created_at DESC)`;

  // 敏感信息单独同意记录（P§9：带时间戳/IP/政策版本号存服务端，游客同样记录）。
  // ip_hash = sha256(ip + RECOVERY_PEPPER)：能判重/审计，还原不出 IP。
  await sql`
    CREATE TABLE IF NOT EXISTS consent_records (
      id BIGSERIAL PRIMARY KEY,
      user_key TEXT NOT NULL,
      granted BOOLEAN NOT NULL,
      policy_version TEXT NOT NULL,
      ip_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_consent_user ON consent_records(user_key, created_at DESC)`;

  // 恢复码尝试审计与限速（P§7/恢复码设计：账号级 5 次/时 + IP 级 20 次/时 +
  // 全局失败锁定）。只存 scope/主体哈希/结果，不存尝试码本身。
  await sql`
    CREATE TABLE IF NOT EXISTS recovery_attempts (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL,           -- 'account' | 'ip' | 'global'
      subject TEXT NOT NULL,         -- username / ip_hash / '*'
      ok BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_recovery_attempts_scope ON recovery_attempts(scope, subject, created_at DESC)`;
}

/**
 * 核心 SQL 执行 + provider 故障切换：异常 → 清 client 缓存 → 切下一个 provider 重试，
 * 全部失败抛最后一次异常。参数校验类错误（非连接问题）请勿包进这里。
 */
export async function execWithFailover<T>(
  run: (sql: SqlClient) => Promise<T>
): Promise<T> {
  const providers = getDbProviders();
  let lastError: unknown;
  for (let i = 0; i < providers.length; i++) {
    try {
      // 切到第 i 个 provider：若与上次不同，清单例让 getSql() 重建
      if (i > 0) _resetSqlCache();
      return await run(getSql());
    } catch (error) {
      lastError = error;
      console.error(`[db] provider ${providers[i].id} failed:`, error);
    }
  }
  throw lastError ?? new Error('未配置任何 DB provider');
}
