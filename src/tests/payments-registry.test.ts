/**
 * 支付注册表中立性单测。
 *
 * 锁住两件事：
 * 1. fail-closed 启用判定——key + webhook secret 缺一即不启用（防"跳过验签"回归）
 * 2. 中立契约——路由层只认 PaymentProviderError 基类、元数据字段齐备
 *   （label/checkoutIdParam/billingNote 是 /api/payments/config 与前端
 *   数据驱动渲染的依赖，缺了会把平台硬编码逼回 UI）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { creemProvider, CreemApiError } from '@/lib/payments/creem';
import {
  getDefaultProvider,
  getEnabledProvider,
  listEnabledProviders,
  listRegisteredProviders,
} from '@/lib/payments/registry';
import { PaymentProviderError } from '@/lib/payments/types';

const PAYMENT_KEYS = ['CREEM_API_KEY', 'CREEM_WEBHOOK_SECRET'];

function clearEnv(): void {
  for (const k of PAYMENT_KEYS) delete process.env[k];
}

beforeEach(clearEnv);

afterEach(clearEnv);

describe('启用判定（fail-closed）', () => {
  it('完全无配置：无启用平台，default 为 null', () => {
    expect(listEnabledProviders()).toEqual([]);
    expect(getDefaultProvider()).toBeNull();
    expect(getEnabledProvider('creem')).toBeNull();
  });

  it('只配 key 不配 webhook secret：不启用（secret 缺失 = 无法验签）', () => {
    process.env.CREEM_API_KEY = 'creem_test_xxx';
    expect(creemProvider.isEnabled()).toBe(false);
    expect(listEnabledProviders()).toEqual([]);
  });

  it('只配 webhook secret 不配 key：不启用', () => {
    process.env.CREEM_WEBHOOK_SECRET = 'whsec_xxx';
    expect(creemProvider.isEnabled()).toBe(false);
  });

  it('key + secret 齐备：启用且为默认平台', () => {
    process.env.CREEM_API_KEY = 'creem_test_xxx';
    process.env.CREEM_WEBHOOK_SECRET = 'whsec_xxx';
    expect(listEnabledProviders().map((p) => p.id)).toEqual(['creem']);
    expect(getDefaultProvider()?.id).toBe('creem');
    expect(getEnabledProvider('creem')?.id).toBe('creem');
  });

  it('未注册的平台 id 查不到', () => {
    process.env.CREEM_API_KEY = 'creem_test_xxx';
    process.env.CREEM_WEBHOOK_SECRET = 'whsec_xxx';
    expect(getEnabledProvider('stripe')).toBeNull();
    expect(getDefaultProvider()?.id).not.toBe('stripe');
  });
});

describe('中立契约', () => {
  it('所有已注册平台都携带前端依赖的元数据', () => {
    for (const p of listRegisteredProviders()) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.checkoutIdParam.length).toBeGreaterThan(0);
    }
  });

  it('adapter 错误类是中立基类的实例（路由层 instanceof 判定的前提）', () => {
    const err = new CreemApiError(429, 'rate limited', 'trace-1');
    expect(err).toBeInstanceOf(PaymentProviderError);
    expect(err.status).toBe(429);
    expect(err.traceId).toBe('trace-1');
  });

  it('billingNote 按测试/生产 key 区分（测试卡号提示只出现在测试模式）', () => {
    process.env.CREEM_API_KEY = 'creem_test_xxx';
    const testNote = creemProvider.billingNote ?? '';
    expect(testNote).toContain('4111');

    process.env.CREEM_API_KEY = 'creem_live_xxx';
    const liveNote = creemProvider.billingNote ?? '';
    expect(liveNote).not.toContain('4111');
    expect(liveNote).toContain('Creem');
  });
});
