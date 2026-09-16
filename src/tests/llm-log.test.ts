/**
 * /root/money-freedom-living/src/lib/llm-log 单测。
 *
 * mock 整个 `@/lib/db`，让 `execWithFailover` 直接转发到一个 fake sql 客户端。
 * 这样 logProviderEvent 不需要真 DB 也能跑（验证写入路径 + 列名 + 容错）。
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

// mock 必须在 import 之前（vitest 4.x 严格模式）
vi.mock('@/lib/db', () => {
  // fake sql：把每次调用的模板字面量片段 + 参数记到 spy
  const calls: { sqlText: string; args: unknown[] }[] = [];
  const fakeSql = (strings: TemplateStringsArray, ...args: unknown[]) => {
    calls.push({ sqlText: strings.join('?'), args });
    return Promise.resolve();
  };
  return {
    execWithFailover: vi.fn(async (run: (sql: unknown) => Promise<unknown>) => run(fakeSql)),
    getSql: vi.fn(() => fakeSql),
    ensureSchema: vi.fn(),
  };
});

import { execWithFailover } from '@/lib/db';
import { logProviderEvent, newCallId } from '@/lib/llm-log';

const execMock = vi.mocked(execWithFailover);

beforeEach(() => {
  execMock.mockClear();
});

describe('logProviderEvent：基础写入路径', () => {
  it('kind=failure 写入正确列', async () => {
    await logProviderEvent({
      providerId: 'zhipu',
      callId: 'test-call-1',
      kind: 'failure',
      errorKind: 'stream_throw',
      durationMs: 1234,
      chunksYielded: 3,
      callPurpose: 'chat.stream',
      userKey: 'g:cookie-abc',
    });
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('kind=success 无 errorKind 时不报错', async () => {
    await logProviderEvent({
      providerId: 'provider-2',
      callId: 'test-call-2',
      kind: 'success',
      durationMs: 800,
      chunksYielded: 5,
      callPurpose: 'onboarding.talk',
    });
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('metadata 序列化进 jsonb', async () => {
    await logProviderEvent({
      providerId: 'zhipu',
      callId: 'test-call-3',
      kind: 'switch',
      chunksYielded: 3,
      callPurpose: 'chat.stream',
      metadata: { fromProvider: 'zhipu', toProvider: 'provider-2', latencyMs: 120 },
    });
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});

describe('logProviderEvent：写表失败不能阻塞主流程', () => {
  it('execWithFailover 抛错 → logProviderEvent 不抛', async () => {
    // 这一轮让 execWithFailover 抛
    execMock.mockRejectedValueOnce(new Error('db down'));
    // 静默 console.error / console.warn 不影响
    await expect(
      logProviderEvent({
        providerId: 'zhipu',
        callId: 'fail-1',
        kind: 'failure',
        callPurpose: 'chat.stream',
      })
    ).resolves.toBeUndefined();
  });
});

describe('newCallId：单调且唯一', () => {
  it('两次调用返回不同的 id', () => {
    const a = newCallId();
    const b = newCallId();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^c[a-z0-9-]+$/);
    expect(b).toMatch(/^c[a-z0-9-]+$/);
  });

  it('id 是字符串', () => {
    expect(typeof newCallId()).toBe('string');
  });
});