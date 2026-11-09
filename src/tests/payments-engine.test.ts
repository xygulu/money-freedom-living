/**
 * 权益引擎（applyPaymentEvent）的 SQL 语义单测。
 *
 * mock 整个 `@/lib/db`（fake sql 记下 SQL 文本与参数）与 `@/lib/entitlements`
 * （归属回查按测试注入）。锁住两条修复，防回归：
 * 1. 估计账期（本地兜底 +31d）绝不覆盖已有账期——否则平台重复投递 checkout.completed、
 *    反查又失败时，vip_until 会被反复前移，还可能抹掉已存真账期。
 * 2. 重算「其余行」的排除条件须同时判 provider + subscription_id——两家平台 id
 *    撞号时，只判 subscription_id 会误排除另一平台的订阅行。
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const resultQueue: Array<Array<Record<string, unknown>>> = [];
const sqlCalls: Array<{ sqlText: string; args: unknown[] }> = [];

vi.mock('@/lib/db', () => {
  const fakeSql = (strings: TemplateStringsArray, ...args: unknown[]) => {
    sqlCalls.push({ sqlText: strings.join('?'), args });
    const rows = resultQueue.shift() ?? [];
    return Promise.resolve(rows);
  };
  return {
    execWithFailover: vi.fn(async (run: (sql: unknown) => Promise<unknown>) => run(fakeSql)),
    getSql: vi.fn(() => fakeSql),
    ensureSchema: vi.fn(),
    iso: (v: unknown) => String(v),
  };
});

vi.mock('@/lib/entitlements', () => ({
  findUserIdByCustomer: vi.fn(async () => null),
  findUserIdByEmail: vi.fn(async () => null),
}));

import { applyPaymentEvent } from '@/lib/payments/engine';
import type { PaymentProvider } from '@/lib/payments/types';

function fakeProvider(): PaymentProvider {
  return {
    id: 'fake',
    label: 'Fake',
    checkoutIdParam: 'checkout_id',
    isEnabled: () => true,
    createCheckout: async () => ({ url: 'https://x', sessionId: 's' }),
    fetchSession: async () => null,
    // 反查返回无账期 → 引擎走本地兜底（estimated）
    fetchSubscription: async () => ({ providerStatus: 'active', periodEnd: null }),
    normalizeStatus: () => ({ status: 'live', willCancel: false }),
    parseWebhook: async () => null,
  };
}

beforeEach(() => {
  resultQueue.length = 0;
  sqlCalls.length = 0;
});

describe('applyPaymentEvent 的落库 SQL', () => {
  it('估计账期（estimated）不覆盖已有账期：CASE 里存在「estimated + 旧值非空 → 保留旧值」分支', async () => {
    // 第 1 次 execWithFailover = userIdExists 查 "user"（返回存在）；第 2 次 = CTE 落库
    resultQueue.push([{ exists: 1 }]);
    resultQueue.push([]);

    await applyPaymentEvent(fakeProvider(), {
      type: 'grant',
      referenceId: 'u1',
      customerId: null,
      customerEmail: null,
      subscriptionId: 'sub-1',
      providerStatus: null,
      periodEnd: null, // → fetchSubscription 也无账期 → fallback estimated
    });

    const cte = sqlCalls.find((c) => c.sqlText.includes('INSERT INTO subscriptions'))?.sqlText;
    expect(cte).toBeTruthy();
    // 核心分支：估计值 + 旧值非空时，current_period_end 与 period_end_estimated 都保留旧值
    expect(cte).toContain('WHEN EXCLUDED.period_end_estimated = true AND subscriptions.current_period_end IS NOT NULL');
    expect(cte).toContain('THEN subscriptions.current_period_end');
    expect(cte).toContain('THEN subscriptions.period_end_estimated');
  });

  it('重算「其余行」的排除条件同时判 provider + subscription_id（防跨平台 id 撞号误排除）', async () => {
    resultQueue.push([{ exists: 1 }]);
    resultQueue.push([]);

    await applyPaymentEvent(fakeProvider(), {
      type: 'grant',
      referenceId: 'u1',
      customerId: null,
      customerEmail: null,
      subscriptionId: 'sub-1',
      providerStatus: null,
      periodEnd: new Date('2026-12-01T00:00:00Z'), // 带真账期，跳过反查
    });

    const cte = sqlCalls.find((c) => c.sqlText.includes('SELECT max(current_period_end)'))?.sqlText;
    expect(cte).toBeTruthy();
    expect(cte).toContain('s.provider <>');
    expect(cte).toContain('s.provider_subscription_id <>');
  });
});
