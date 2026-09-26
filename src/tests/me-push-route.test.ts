import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, DELETE } from '../app/api/me/push/route';
import { resolveIdentity } from '@/lib/identity';
import { ensureProfile, upsertPushToken, removePushToken } from '@/lib/profile';

// /api/me/push（docs/11 M2）：壳上报 APNs token 的形状闸。
// mock 身份与档案写函数——DB 不进单测；游客可上报是本路由的明确语义（同 wishes 的理由）。

vi.mock('@/lib/identity', () => ({
  resolveIdentity: vi.fn(async () => ({ key: 'u:test', userId: 'test', newGuestCookie: null })),
}));

vi.mock('@/lib/profile', () => ({
  ensureProfile: vi.fn(async () => null),
  upsertPushToken: vi.fn(async () => []),
  removePushToken: vi.fn(async () => undefined),
}));

const mockedIdentity = vi.mocked(resolveIdentity);
const mockedUpsert = vi.mocked(upsertPushToken);
const mockedRemove = vi.mocked(removePushToken);

function postRequest(body: unknown) {
  return { json: async () => body } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedIdentity.mockResolvedValue({ key: 'u:test', userId: 'test', newGuestCookie: null });
});

describe('POST /api/me/push', () => {
  it('合法 token → 上报成功；platform 缺省按 ios', async () => {
    const res = await POST(postRequest({ token: 'aB3dEf7hIj9kLmNpQrStUvWxYz0123456789' }));
    expect(res.status).toBe(200);
    expect(mockedUpsert).toHaveBeenCalledWith('u:test', 'aB3dEf7hIj9kLmNpQrStUvWxYz0123456789', 'ios');
    expect(mockedUpsert.mock.calls[0]?.[1]).toHaveLength(36);
  });

  it('token 形状坏（过短/带符号外字符）→ 400 invalid_token，不落库', async () => {
    for (const bad of ['short', 'has spaces and is definitely long enough to pass', '符号!不允许的也需要足够长才行吧确实如此']) {
      const res = await POST(postRequest({ token: bad }));
      expect(res.status).toBe(400);
    }
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('platform 非 ios → 400 invalid_platform（首版只发 iOS，docs/11 §5）', async () => {
    const res = await POST(postRequest({ token: 'aB3dEf7hIj9kLmNpQrStUvWxYz0123456789', platform: 'android' }));
    expect(res.status).toBe(400);
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it('游客可上报：identity.key 为 g: 时照常写入（卸载即消失的档案，push 是唯一召回道）', async () => {
    mockedIdentity.mockResolvedValue({ key: 'g:abc123', userId: null, newGuestCookie: 'g=abc123' });
    const res = await POST(postRequest({ token: 'aB3dEf7hIj9kLmNpQrStUvWxYz0123456789' }));
    expect(res.status).toBe(200);
    expect(mockedUpsert).toHaveBeenCalledWith('g:abc123', expect.any(String), 'ios');
    expect(mockedIdentity.mock.calls.length).toBe(1);
  });

  it('游客首访种 cookie：newGuestCookie 挂到 Set-Cookie（同 wishes 的响应形状）', async () => {
    mockedIdentity.mockResolvedValue({ key: 'g:abc123', userId: null, newGuestCookie: 'g=abc123' });
    const res = await POST(postRequest({ token: 'aB3dEf7hIj9kLmNpQrStUvWxYz0123456789' }));
    expect((res.headers.get('Set-Cookie') ?? '').length).toBeGreaterThan(0);
  });
});

describe('DELETE /api/me/push', () => {
  it('带合法 token → 按 token 精确移除', async () => {
    const req = {
      nextUrl: { searchParams: new URLSearchParams('token=aB3dEf7hIj9kLmNpQrStUvWxYz0123456789') },
    } as never;
    const res = await DELETE(req);
    expect(res.status).toBe(200);
    expect(mockedRemove).toHaveBeenCalledWith('u:test', 'aB3dEf7hIj9kLmNpQrStUvWxYz0123456789');
  });

  it('token 缺失/非法 → 400，不动档案', async () => {
    const res = await DELETE({
      nextUrl: { searchParams: new URLSearchParams('token=xx') },
    } as never);
    expect(res.status).toBe(400);
    expect(mockedRemove).not.toHaveBeenCalled();
  });
});
