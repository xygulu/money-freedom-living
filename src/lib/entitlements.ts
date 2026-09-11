import { ensureSchema, execWithFailover } from '@/lib/db';

/**
 * 站内权益层（多平台中立）。
 *
 * 职责分离：
 *   - subscriptions 表（平台侧状态，lib/payments/engine.ts 是唯一写入方）
 *   - entitlements 表（本文件：站内权益快速判定，一行一个用户）
 *
 * isVip 唯一真源 = entitlements.vip_until > now()，vip_until 由权益引擎在
 * 每次 pay 事件后"重算"：该用户所有 live/grace 订阅的 current_period_end 最大值。
 * webhook 丢失时到期自然失效（自愈），续费事件再延长；多平台并存取最大账期。
 * 读侧（配额/功能门禁/UI）只认这张表，永远不知道支付平台的存在。
 */

export interface Entitlement {
  vipUntil: string | null; // ISO 时间；null = 无有效会员
}

/** 读某用户权益（无记录返回 null） */
export async function getEntitlement(userId: string): Promise<Entitlement | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT vip_until FROM entitlements WHERE user_id = ${userId} LIMIT 1`
  );
  const row = rows[0];
  if (!row) return null;
  return { vipUntil: row.vip_until ? new Date(row.vip_until as string).toISOString() : null };
}

/** VIP 判定（高频路径，只查需要的一列） */
export async function isUserVip(userId: string): Promise<boolean> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`
      SELECT 1 FROM entitlements
      WHERE user_id = ${userId} AND vip_until > now() LIMIT 1
    `
  );
  return rows.length > 0;
}

/** 重算某用户 vip_until = live/grace 订阅账期最大值（单条 SQL，幂等） */
export async function recomputeForUser(userId: string): Promise<void> {
  await ensureSchema();
  await execWithFailover((sql) =>
    sql`
      INSERT INTO entitlements (user_id, vip_until, updated_at)
      VALUES (${userId},
              (SELECT max(current_period_end) FROM subscriptions
               WHERE user_id = ${userId} AND status IN ('live', 'grace')),
              now())
      ON CONFLICT (user_id) DO UPDATE SET
        vip_until = EXCLUDED.vip_until,
        updated_at = now()
    `
  );
}

/**
 * 用户当前最值得展示/可管理的一条订阅（portal 入口与 UI 状态展示用）：
 * 优先 live/grace 中最近更新的；一条都没有时回退最近的 ended 行
 * （已取消用户也要能进门户查看账单/重新订阅）。
 */
export async function getLatestLiveSubscription(
  userId: string
): Promise<{
  provider: string;
  providerCustomerId: string | null;
  status: string; // 中立三态 live/grace/ended
  willCancel: boolean;
} | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`
      SELECT provider, provider_customer_id, status, will_cancel FROM subscriptions
      WHERE user_id = ${userId}
      ORDER BY (status = 'ended') ASC, updated_at DESC
      LIMIT 1
    `
  );
  const row = rows[0];
  if (!row) return null;
  return {
    provider: String(row.provider),
    providerCustomerId: (row.provider_customer_id as string) ?? null,
    status: String(row.status),
    willCancel: Boolean(row.will_cancel),
  };
}

/**
 * 用户在某平台是否已有生效中的订阅（live/grace）。
 * checkout 路由用它防重复订阅：已生效再开一单 = 平台侧二次扣费。
 * （跨平台并存是设计允许的——多平台各查各的。已排期取消的也算生效中，
 * 想立即重开让用户去门户撤销取消。）
 */
export async function hasActiveSubscriptionOn(userId: string, provider: string): Promise<boolean> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`
      SELECT 1 FROM subscriptions
      WHERE user_id = ${userId} AND provider = ${provider} AND status IN ('live', 'grace')
      LIMIT 1
    `
  );
  return rows.length > 0;
}

// ---------- 归属回查（payments/engine.ts 用） ----------

/** 按平台 + 平台 customer id 反查本站用户 */
export async function findUserIdByCustomer(
  provider: string,
  providerCustomerId: string
): Promise<string | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`
      SELECT user_id FROM subscriptions
      WHERE provider = ${provider} AND provider_customer_id = ${providerCustomerId}
      LIMIT 1
    `
  );
  return rows.length > 0 ? String(rows[0].user_id) : null;
}

/** 按结账邮箱兜底匹配本站用户（首次支付、无 referenceId/customer 记录时）。
 *  ⚠️ lower() 比较：平台侧录入的邮箱大小写不一定与本站一致。 */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  await ensureSchema();
  const rows = await execWithFailover(
    (sql) => sql`SELECT id FROM "user" WHERE lower(email) = lower(${email}) LIMIT 1`
  );
  return rows.length > 0 ? String(rows[0].id) : null;
}
