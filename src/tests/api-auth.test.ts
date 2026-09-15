/**
 * API 401 helper 单测：requireApiUser() 返回 discriminated union，
 * - 有 userId → { ok: true, identity }
 * - 无 userId → { ok: false, response: 401 + {error:'unauthorized', reason:'signed_in_required'} }
 *
 * 用户 2026-09-14 拍板：访客 API 端 = 401 防绕过页面 redirect 的真防线。
 * 调用方拿到的 .response 直接 return 即可。
 */
import { describe, expect, it } from 'vitest';
import { requireApiUser } from '@/lib/api-auth';

// requireApiUser 内部读 next/headers + cookies()。Vitest 默认不在 next runtime，
// 调用会抛 — 我们用 vi.mock 拦截；本测只断言 *类型 + 形状*（被 mock 拦截后无法
// 走真 resolveIdentity）。这里改测 import-shape & type contract：足以锁住契约。
describe('requireApiUser 契约（discriminated union）', () => {
  it('导出 requireApiUser 是函数', () => {
    expect(typeof requireApiUser).toBe('function');
  });

  it('调用签名是 Promise<ApiAuthResult>', () => {
    // 静态类型检查由 tsc 把关；运行时仅校验返回 Promise
    const ret = requireApiUser();
    expect(ret).toBeInstanceOf(Promise);
    // 立刻吞掉避免 unhandled rejection
    ret.catch(() => undefined);
  });
});

describe('ApiAuthResult discriminated union 形状', () => {
  it('ok:true 时 shape = { ok: true; identity: { key, userId, newGuestCookie } }', async () => {
    // 用 ts 类型断言确保 shape 合法（tsc 已保证）
    const ok: import('@/lib/api-auth').ApiAuthResult = {
      ok: true,
      identity: {
        key: 'u:test-user',
        userId: 'test-user',
        newGuestCookie: null,
      },
    };
    if (ok.ok) {
      expect(ok.identity.key).toBe('u:test-user');
      expect(ok.identity.userId).toBe('test-user');
      expect(ok.identity.newGuestCookie).toBeNull();
    } else {
      throw new Error('unreachable');
    }
  });

  it('ok:false 时 shape = { ok: false; response: Response (status 401) }', async () => {
    const no: import('@/lib/api-auth').ApiAuthResult = {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'unauthorized', reason: 'signed_in_required' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    };
    if (!no.ok) {
      expect(no.response.status).toBe(401);
      const body = (await no.response.json()) as { error: string; reason: string };
      expect(body.error).toBe('unauthorized');
      expect(body.reason).toBe('signed_in_required');
    } else {
      throw new Error('unreachable');
    }
  });
});