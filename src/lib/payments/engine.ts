import { ensureSchema, execWithFailover } from '@/lib/db';
import {
  findUserIdByCustomer,
  findUserIdByEmail,
} from '@/lib/entitlements';
import type { PaymentEvent, PaymentProvider } from './types';

/** 本地/收不到 webhook 时的兜底会员期（约一个账期），落库会标记 period_end_estimated */
const GRANT_FALLBACK_DAYS = 31;

/** 兜底账期：查不到平台账期时给约一个账期，宁可多发一天不误伤付费用户 */
function fallbackPeriodEnd(now = new Date()): Date {
  return new Date(now.getTime() + GRANT_FALLBACK_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * 通用权益引擎：把任意平台的中立事件落到 subscriptions + entitlements。
 *
 * 不变量：
 * - 归属三级回查：referenceId（结账时埋的本站 userId，必须真实存在）→
 *   本平台 customer_id 反查 subscriptions → 结账邮箱。全部失败只记日志返回 null
 *   （webhook 仍 200，让平台停止重试；人工排查）。
 * - vip_until 重算：单条 CTE 语句内完成"upsert 订阅行 + 重算 entitlements"，
 *   原子性由 Postgres 单语句快照保证（Neon HTTP 驱动无跨语句事务）。
 * - 账期来源优先级：事件载荷 → 平台反查（fetchSubscription）→ estimated 兜底
 *   （+约一个账期，落库标记 period_end_estimated，绝不把编造值混充平台真源）。
 * - 未知状态（normalizeStatus 返回 null）只更新 provider_status，绝不动权益。
 */

export async function applyPaymentEvent(
  provider: PaymentProvider,
  event: PaymentEvent
): Promise<string | null> {
  // 1) 归属用户
  const userId = await resolveUserId(provider.id, event);
  if (!userId) {
    console.error(`[payments/${provider.id}] 事件无法归属用户，已忽略:`, {
      subscriptionId: event.subscriptionId,
      customerId: event.customerId,
      customerEmail: event.customerEmail,
      referenceId: event.referenceId,
      type: event.type,
    });
    return null;
  }

  // 2) 账期与状态：事件没有的向平台反查
  let providerStatus = event.providerStatus;
  let periodEnd = 'periodEnd' in event ? event.periodEnd : null;
  if (event.type !== 'revoke' && periodEnd === null) {
    try {
      const sub = await provider.fetchSubscription(event.subscriptionId);
      if (sub) {
        periodEnd = sub.periodEnd;
        providerStatus = sub.providerStatus ?? providerStatus;
      }
    } catch (error) {
      // 平台抖动不挡授权：走 estimated 兜底
      console.error(`[payments/${provider.id}] 拉取订阅详情失败，走兜底账期:`, error);
    }
  }

  // 3) 中立状态：未知 → 只更新 provider_status（status/will_cancel 传 NULL 保留旧值）
  const normalized = providerStatus ? provider.normalizeStatus(providerStatus) : null;
  if (providerStatus && !normalized) {
    console.warn(`[payments/${provider.id}] 未知订阅状态 "${providerStatus}"，仅记录不改变权益`);
  }

  let status: string | null = normalized?.status ?? null;
  let willCancel: boolean | null = normalized?.willCancel ?? null;
  let periodEndEstimated: boolean | null = null; // null = 不改动旧标记

  if (event.type === 'grant') {
    // grant 是权威"已付款"信号：状态映射缺失也按 live 处理（记日志留痕）
    status = normalized?.status ?? 'live';
    if (!normalized) {
      console.warn(`[payments/${provider.id}] grant 事件状态 "${providerStatus}" 未知，按 live 处理`);
    }
    willCancel = normalized?.willCancel ?? false;
    if (periodEnd === null) {
      periodEnd = fallbackPeriodEnd();
      periodEndEstimated = true;
    }
  } else if (event.type === 'revoke') {
    status = 'ended';
    willCancel = false;
  }

  // 4) 单语句原子落库：upsert 订阅行 → 同语句重算 vip_until。
  // ⚠️ Postgres 数据修改型 CTE 与主查询共用同一快照——主查询看不到本语句
  // 刚 upsert 的行。因此"本行"的贡献（status/current_period_end）经 RETURNING
  // 注入，max() 只统计"其余行"，再 GREATEST 合并；否则重算永远漏掉触发事件
  // 的那条订阅（首次授权会算出 NULL，实测踩过）。
  await ensureSchema();
  await execWithFailover((sql) =>
    sql`
      WITH sub AS (
        INSERT INTO subscriptions
          (user_id, provider, provider_customer_id, provider_subscription_id,
           status, provider_status, will_cancel, current_period_end, period_end_estimated, updated_at)
        VALUES (${userId}, ${provider.id}, ${event.customerId}, ${event.subscriptionId},
                -- 未见过的订阅收到未知状态事件：按 ended 建行（不授权益）；
                -- 已存在的行走下方 DO UPDATE 的 COALESCE，保留原状态
                COALESCE(${status}, 'ended'), ${providerStatus}, ${willCancel}, ${periodEnd?.toISOString() ?? null}, ${periodEndEstimated}, now())
        ON CONFLICT (provider, provider_subscription_id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id),
          status = COALESCE(EXCLUDED.status, subscriptions.status),
          provider_status = COALESCE(EXCLUDED.provider_status, subscriptions.provider_status),
          will_cancel = COALESCE(EXCLUDED.will_cancel, subscriptions.will_cancel),
          -- info 事件常不带账期：NULL 表示保留旧账期，不用编造值覆盖平台真源
          current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
          period_end_estimated = COALESCE(EXCLUDED.period_end_estimated, subscriptions.period_end_estimated),
          updated_at = now()
        RETURNING user_id, status, current_period_end
      )
      INSERT INTO entitlements (user_id, vip_until, updated_at)
      SELECT user_id,
             GREATEST(
               (SELECT max(current_period_end) FROM subscriptions s
                WHERE s.user_id = sub.user_id
                  AND s.provider_subscription_id <> ${event.subscriptionId}
                  AND s.status IN ('live', 'grace')),
               CASE WHEN sub.status IN ('live', 'grace') THEN sub.current_period_end END
             ),
             now()
      FROM sub
      ON CONFLICT (user_id) DO UPDATE SET
        vip_until = EXCLUDED.vip_until,
        updated_at = now()
    `
  );
  return userId;
}

async function resolveUserId(
  providerId: string,
  event: PaymentEvent
): Promise<string | null> {
  if (event.referenceId && (await userIdExists(event.referenceId))) {
    return event.referenceId;
  }
  if (event.customerId) {
    const byCustomer = await findUserIdByCustomer(providerId, event.customerId);
    if (byCustomer) return byCustomer;
  }
  if (event.customerEmail) {
    const byEmail = await findUserIdByEmail(event.customerEmail);
    if (byEmail) return byEmail;
  }
  return null;
}

/** referenceId 必须真实存在才采用（防脏 metadata 建出孤儿行） */
async function userIdExists(userId: string): Promise<boolean> {
  await ensureSchema();
  const rows = await execWithFailover(
    (sql) => sql`SELECT 1 FROM "user" WHERE id = ${userId} LIMIT 1`
  );
  return rows.length > 0;
}
