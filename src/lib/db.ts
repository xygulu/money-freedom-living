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
