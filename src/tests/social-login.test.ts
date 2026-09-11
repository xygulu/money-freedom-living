// 社交登录可用性：凭证（ID+SECRET）成对齐全才算启用，缺失即优雅降级为无按钮。
// auth.ts 里 socialProviders 同样按 env 条件入列——这里保证两处判定一致（同一函数事实源）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnabledSocialProviders } from '@/lib/auth';

const ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'] as const;

function stubEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) vi.stubEnv(key, values[key] ?? '');
}

describe('getEnabledSocialProviders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('凭证全缺 → 空数组（登录页不渲染社交按钮）', () => {
    stubEnv({});
    expect(getEnabledSocialProviders()).toEqual([]);
  });

  it('只有 ID 没有 SECRET → 不启用（不成对不入列）', () => {
    stubEnv({ GOOGLE_CLIENT_ID: 'id-only' });
    expect(getEnabledSocialProviders()).toEqual([]);
  });

  it('Google 成对 → 仅 google', () => {
    stubEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
    expect(getEnabledSocialProviders()).toEqual(['google']);
  });

  it('两对齐全 → google、github 都启用', () => {
    stubEnv({
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsecret',
      GITHUB_CLIENT_ID: 'hid',
      GITHUB_CLIENT_SECRET: 'hsecret',
    });
    expect(getEnabledSocialProviders()).toEqual(['google', 'github']);
  });
});
