/**
 * /root/money-freedom-living/src/lib/llm failover 单测（commit #3 核心）。
 *
 * 6 场景直接覆盖设计稿 §8：
 * 1. 首 provider 失败 → 切下一个
 * 2. zhipu 推畸形 event → 容错跳过，第二个 event 正常 yield
 * 3. 流中途失败 → marker + 切下一个 provider 整请求重发
 * 4. timeout → 切下一个
 * 5. cooldown 后再次尝试 → isEnabled 自动恢复
 * 6. 429 → 不累加 consecutiveFailures
 *
 * mock @anthropic-ai/sdk 与 @/lib/llm-health（vi.mock 工厂无外部变量约束，
 * 用 vi.hoisted 提前构造 vi.fn；vitest 4.x 严格）。
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const { mockGetProviderHealth, mockLogProviderEvent, sdkMocks } = vi.hoisted(() => {
  const mockGetProviderHealth = vi.fn();
  const mockLogProviderEvent = vi.fn().mockResolvedValue(undefined);
  const sdkCreate = vi.fn();
  const sdkStream = vi.fn();
  return {
    mockGetProviderHealth,
    mockLogProviderEvent,
    sdkMocks: { create: sdkCreate, stream: sdkStream },
  };
});

vi.mock('@/lib/llm-health', async () => {
  const original = await vi.importActual<typeof import('@/lib/llm-health')>('@/lib/llm-health');
  return {
    ProviderHealth: original.ProviderHealth,
    getProviderHealth: mockGetProviderHealth,
    setProviderHealth: vi.fn(),
  };
});

vi.mock('@/lib/llm-log', () => ({
  logProviderEvent: mockLogProviderEvent,
  newCallId: vi.fn(() => 'test-call-id'),
}));

// SDK mock —— 必须返回 default export
vi.mock('@anthropic-ai/sdk', () => {
  function Anthropic(this: any, _config: any) {
    this.messages = { create: sdkMocks.create, stream: sdkMocks.stream };
  }
  return { default: Anthropic };
});

import { getLlmProviders, llmStream } from '@/lib/llm';
import { ProviderHealth } from '@/lib/llm-health';

let health: ProviderHealth;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-token';
  process.env.ANTHROPIC_BASE_URL = 'https://anthropic.test/v1';
  process.env.ANTHROPIC_MODEL = 'glm-test';
  process.env.LLM_PROVIDER_2_BASE_URL = 'https://provider-2.test/v1';
  process.env.LLM_PROVIDER_2_AUTH_TOKEN = 'test-token-2';
  process.env.LLM_PROVIDER_2_MODEL = 'model-2';

  health = new ProviderHealth();
  mockGetProviderHealth.mockReturnValue(health);

  sdkMocks.create.mockReset();
  sdkMocks.stream.mockReset();
  mockLogProviderEvent.mockClear();
});

describe('getLlmProviders：基础读取', () => {
  it('env 齐 → 返回两个 provider', () => {
    const list = getLlmProviders();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe('zhipu');
    expect(list[1].id).toBe('provider-2');
    expect(list.every((p) => p.enabled === true)).toBe(true);
  });

  it('只配 zhipu → 只有一个 provider', () => {
    delete process.env.LLM_PROVIDER_2_BASE_URL;
    delete process.env.LLM_PROVIDER_2_AUTH_TOKEN;
    delete process.env.LLM_PROVIDER_2_MODEL;
    expect(getLlmProviders().length).toBe(1);
  });

  it('provider 在 cooldown 内 → isEnabled=false 排除', () => {
    health.recordFailure('zhipu', 'server_5xx', Date.now());
    health.recordFailure('zhipu', 'server_5xx', Date.now());
    health.recordFailure('zhipu', 'server_5xx', Date.now());
    const list = getLlmProviders();
    expect(list.find((p) => p.id === 'zhipu')).toBeUndefined();
    expect(list.find((p) => p.id === 'provider-2')).toBeDefined();
  });
});

describe('llmStream：failover 主流程', () => {
  it('场景 1：首 provider 失败 → 切下一个，整请求重发', async () => {
    sdkMocks.stream.mockRejectedValueOnce(new Error('zhipu down'));
    sdkMocks.stream.mockImplementation(async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fallback hi' } } as any;
    });

    const collected: string[] = [];
    for await (const c of llmStream({ system: 's', messages: [{ role: 'user', content: 'q' }] })) {
      if (typeof c === 'string') collected.push(c);
    }
    expect(collected).toEqual(['fallback hi']);
    const calls = mockLogProviderEvent.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.kind === 'failure' && c.providerId === 'zhipu')).toBeTruthy();
    expect(calls.find((c) => c.kind === 'success' && c.providerId === 'provider-2')).toBeTruthy();
  });

  it('场景 2：zhipu 推畸形 event → 容错跳过，后续正常 yield', async () => {
    sdkMocks.stream.mockImplementation(async function* () {
      yield { type: 'content_block_delta' } as any; // 缺 delta
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } } as any;
    });
    const collected: string[] = [];
    for await (const c of llmStream({ system: 's', messages: [{ role: 'user', content: 'q' }] })) {
      if (typeof c === 'string') collected.push(c);
    }
    expect(collected).toEqual(['hello']);
    const malformedCalls = mockLogProviderEvent.mock.calls.filter((c) => c[0].kind === 'malformed_event');
    expect(malformedCalls.length).toBeGreaterThan(0);
  });

  it('场景 3：流中途失败 → marker + 切下一个 provider', async () => {
    sdkMocks.stream.mockImplementationOnce(async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'part1' } } as any;
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'part2' } } as any;
      throw new Error('mid-stream zhipu crash');
    });
    sdkMocks.stream.mockImplementationOnce(async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '-rest' } } as any;
    });

    const collected: string[] = [];
    const markers: any[] = [];
    const switches: any[] = [];
    for await (const c of llmStream({
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      onProviderSwitch: (e) => switches.push(e),
    })) {
      if (typeof c === 'string') collected.push(c);
      else markers.push(c);
    }
    expect(collected).toEqual(['part1', 'part2', '-rest']);
    expect(markers.length).toBe(1);
    expect(markers[0].from).toBe('zhipu');
    expect(markers[0].to).toBe('provider-2');
    expect(markers[0].chunksYielded).toBe(2);
    expect(markers[0].reason).toBe('stream_throw');
    expect(switches).toEqual([
      { from: 'zhipu', to: 'provider-2', reason: 'stream_throw', chunksYielded: 2 },
    ]);
  });

  it('场景 4：timeout → classifyError=timeout + 切下一个', async () => {
    // 模拟 SDK stream 在中途抛 AbortError（贴近 SDK timeout 真实行为）
    const timeoutErr: any = new Error('request timeout');
    timeoutErr.name = 'AbortError';
    sdkMocks.stream.mockImplementationOnce(async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'before-timeout' } } as any;
      throw timeoutErr;
    });
    sdkMocks.stream.mockImplementationOnce(async function* () {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'after-timeout' } } as any;
    });
    const collected: string[] = [];
    for await (const c of llmStream({ system: 's', messages: [{ role: 'user', content: 'q' }] })) {
      if (typeof c === 'string') collected.push(c);
    }
    expect(collected).toEqual(['before-timeout', 'after-timeout']);
    const failureCall = mockLogProviderEvent.mock.calls.find((c) => c[0].kind === 'failure' && c[0].providerId === 'zhipu');
    expect(failureCall?.[0].errorKind).toBe('timeout');
  });

  it('场景 5：cooldown 结束后下次 isEnabled=true（ProviderHealth 行为）', () => {
    health.recordFailure('zhipu', 'server_5xx', 0);
    health.recordFailure('zhipu', 'server_5xx', 0);
    health.recordFailure('zhipu', 'server_5xx', 0);
    expect(health.isEnabled('zhipu', 0)).toBe(false);
    expect(health.isEnabled('zhipu', 60_001)).toBe(true);
  });

  it('场景 6：429 → 不累加 consecutiveFailures', () => {
    for (let i = 0; i < 3; i++) health.recordRateLimit('zhipu', i);
    expect(health.snapshot()[0].consecutiveFailures).toBe(0);
    expect(health.snapshot()[0].lastErrorKind).toBe('rate_limit');
  });
});