/**
 * /root/money-freedom-living/src/lib/llm-health 单测。
 *
 * 测试 ProviderHealth 状态机：连续失败 → cooldown、429 短冷却、cooldown 结束恢复、成功重置。
 * 用注入 `now` 避免 sleep，测试瞬间跑完。
 */
import { describe, it, expect } from 'vitest';
import { ProviderHealth } from '@/lib/llm-health';
import { COOLDOWN_MAX_MS, RATE_LIMIT_COOLDOWN_MS } from '@/lib/llm-config';

const T0 = 1_000_000_000_000; // 任意固定时刻

describe('ProviderHealth：默认全可用', () => {
  it('未登记的 provider → isEnabled=true', () => {
    const h = new ProviderHealth();
    expect(h.isEnabled('zhipu', T0)).toBe(true);
  });

  it('snapshot 返回空数组', () => {
    const h = new ProviderHealth();
    expect(h.snapshot()).toEqual([]);
  });
});

describe('ProviderHealth：连续失败 → cooldown', () => {
  it('第 1-2 次失败不 cooldown（仅计数）', () => {
    const h = new ProviderHealth();
    h.recordFailure('zhipu', 'server_5xx', T0);
    h.recordFailure('zhipu', 'server_5xx', T0);
    // 第 2 次还不到 cooldown 门槛（FAILURE_THRESHOLD=3）
    expect(h.isEnabled('zhipu', T0)).toBe(true);
    expect(h.snapshot()[0].consecutiveFailures).toBe(2);
  });

  it('第 3 次失败进入 cooldown', () => {
    const h = new ProviderHealth();
    h.recordFailure('zhipu', 'server_5xx', T0);
    h.recordFailure('zhipu', 'server_5xx', T0);
    h.recordFailure('zhipu', 'server_5xx', T0);
    // 第 3 次触发 cooldown（failures=3 → STEPS[2] = 60s step）
    expect(h.isEnabled('zhipu', T0)).toBe(false);
    // 30s 后仍未恢复
    expect(h.isEnabled('zhipu', T0 + 30_000)).toBe(false);
    // 60s 后恢复
    expect(h.isEnabled('zhipu', T0 + 60_001)).toBe(true);
  });

  it('指数退避：连续失败 6 次，cooldown 封顶 5 分钟', () => {
    const h = new ProviderHealth();
    for (let i = 0; i < 6; i++) {
      h.recordFailure('zhipu', 'server_5xx', T0 + i * 1);
    }
    // 第 6 次失败时间 = T0+5（failures=6 → STEPS[3]=300s 封顶）
    // → cooldownUntil = (T0+5) + 300_000 = T0 + 300_005
    expect(h.isEnabled('zhipu', T0 + 100_000)).toBe(false);
    expect(h.isEnabled('zhipu', T0 + 300_004)).toBe(false);
    expect(h.isEnabled('zhipu', T0 + 300_006)).toBe(true);
  });

  it('cooldown 期内再失败 → 延长不缩短（取 max）', () => {
    const h = new ProviderHealth();
    // 第 3 次失败（T0+0）→ STEPS[2]=60s cooldown → cooldownUntil = T0+60_000
    h.recordFailure('zhipu', 'server_5xx', T0);
    h.recordFailure('zhipu', 'server_5xx', T0);
    h.recordFailure('zhipu', 'server_5xx', T0);
    // 第 4 次失败在 cooldown 内（T0+30_000）→ STEPS[3]=300s，从 now 算 = T0+330_000
    h.recordFailure('zhipu', 'server_5xx', T0 + 30_000);
    // cooldownUntil 应是 max(T0+60_000, T0+330_000) = T0+330_000
    expect(h.isEnabled('zhipu', T0 + 100_000)).toBe(false); // 旧 cooldown 已被覆盖
    expect(h.isEnabled('zhipu', T0 + 330_001)).toBe(true);
  });

  it('config_4xx 立即封顶 5 分钟（不等阈值）', () => {
    const h = new ProviderHealth();
    h.recordFailure('zhipu', 'config_4xx', T0);
    // 立刻不可用
    expect(h.isEnabled('zhipu', T0)).toBe(false);
    // 5 分钟后恢复
    expect(h.isEnabled('zhipu', T0 + COOLDOWN_MAX_MS + 1)).toBe(true);
  });
});

describe('ProviderHealth：429 限流不算硬故障', () => {
  it('一次 429 → 触发 30s 短冷却，consecutiveFailures 不变', () => {
    const h = new ProviderHealth();
    h.recordFailure('zhipu', 'server_5xx', T0); // 1 次硬失败
    h.recordRateLimit('zhipu', T0); // 一次 429
    // 短冷却期内不可用
    expect(h.isEnabled('zhipu', T0 + 5_000)).toBe(false);
    expect(h.isEnabled('zhipu', T0 + RATE_LIMIT_COOLDOWN_MS - 1)).toBe(false);
    // 30s 后恢复（但 consecutiveFailures 仍是 1，未被 429 重置）
    expect(h.isEnabled('zhipu', T0 + RATE_LIMIT_COOLDOWN_MS + 1)).toBe(true);
    const snap = h.snapshot()[0];
    expect(snap.consecutiveFailures).toBe(1);
    expect(snap.lastErrorKind).toBe('rate_limit');
  });

  it('多次 429 不累加 consecutiveFailures', () => {
    const h = new ProviderHealth();
    for (let i = 0; i < 5; i++) {
      h.recordRateLimit('zhipu', T0 + i * 1);
    }
    expect(h.snapshot()[0].consecutiveFailures).toBe(0);
  });

  it('已在 cooldown 时再 429 不覆盖冷却时长', () => {
    const h = new ProviderHealth();
    h.recordFailure('zhipu', 'server_5xx', T0); // 1 次
    h.recordFailure('zhipu', 'server_5xx', T0); // 2 次
    h.recordFailure('zhipu', 'server_5xx', T0); // 3 次 → STEPS[2]=60s cooldown = T0+60_000
    // 此时还在 60s cooldown 内
    h.recordRateLimit('zhipu', T0 + 5_000); // 半路打 429
    // cooldown 应仍是 60s（不被 30s 覆盖）
    expect(h.isEnabled('zhipu', T0 + 5_000)).toBe(false);
    expect(h.isEnabled('zhipu', T0 + 60_001)).toBe(true);
  });
});

describe('ProviderHealth：成功重置', () => {
  it('recordSuccess 清零 consecutiveFailures + cooldown', () => {
    const h = new ProviderHealth();
    h.recordFailure('zhipu', 'server_5xx', T0);
    h.recordFailure('zhipu', 'server_5xx', T0);
    h.recordFailure('zhipu', 'server_5xx', T0);
    h.recordSuccess('zhipu');
    const snap = h.snapshot()[0];
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.cooldownUntil).toBe(0);
    expect(h.isEnabled('zhipu', T0)).toBe(true);
  });
});

describe('ProviderHealth：snapshot', () => {
  it('按登记顺序返回', () => {
    const h = new ProviderHealth();
    h.recordFailure('zhipu', 'server_5xx', T0);
    h.recordSuccess('provider-2');
    const snap = h.snapshot();
    expect(snap.length).toBe(2);
    expect(snap.find((s) => s.id === 'zhipu')).toBeDefined();
    expect(snap.find((s) => s.id === 'provider-2')).toBeDefined();
  });
});