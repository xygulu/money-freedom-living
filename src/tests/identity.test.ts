/**
 * requireSignedIn + isSignedIn 单测。
 *
 * - isSignedIn(identity) = identity.userId !== null
 * - requireSignedIn(locale, nextPath)：访客时 redirect('/{locale}/login?next={...}')；
 *   已登录时直接返回 identity
 *
 * 注：requireSignedIn 用 next/navigation 的 redirect()——该函数抛 NEXT_REDIRECT 错误
 * 走出当前 render；vitest 不在 next runtime，调用会抛。
 * 因此本测仅断言 isSignedIn 的纯函数语义 + requireSignedIn 的签名形状。
 */
import { describe, expect, it } from 'vitest';
import { isSignedIn, type RequestIdentity } from '@/lib/identity';

describe('isSignedIn（纯函数）', () => {
  it('userId !== null → 已登录', () => {
    const identity: RequestIdentity = { key: 'u:abc', userId: 'abc', newGuestCookie: null };
    expect(isSignedIn(identity)).toBe(true);
  });

  it('userId === null → 访客', () => {
    const identity: RequestIdentity = { key: 'g:xyz', userId: null, newGuestCookie: null };
    expect(isSignedIn(identity)).toBe(false);
  });

  it('newGuestCookie 有值仍算访客（首访种 cookie 阶段 userId 还是 null）', () => {
    const identity: RequestIdentity = {
      key: 'g:new',
      userId: null,
      newGuestCookie: 'mfl_guest=new; Path=/; Max-Age=63072000',
    };
    expect(isSignedIn(identity)).toBe(false);
  });
});

describe('requireSignedIn 签名', () => {
  it('导出且是函数', async () => {
    const mod = await import('@/lib/identity');
    expect(typeof mod.requireSignedIn).toBe('function');
  });
});