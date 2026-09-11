// 统一身份解析：登录用户 u:<userId>，游客 g:<稳定 cookie id>。
//
// 与 quota.ts 游客键的区别：配额键掺了 day（跨日清零是配额语义），
// 档案键必须跨日稳定——同一个浏览器明天回来，AI 还得记得他。
// 所以这里直接用匿名 cookie id 本体（32 位 hex，无 PII），不掺日期、不再哈希。
import { auth } from '@/lib/auth';
import { GUEST_ID_COOKIE, isValidGuestId, newGuestId, guestCookieHeader } from '@/lib/quota';

export interface RequestIdentity {
  /** growth_profiles.user_key：u:userId 或 g:<cookieId> */
  key: string;
  userId: string | null;
  /** 非空时路由必须把它挂到响应的 Set-Cookie（游客首访种身份） */
  newGuestCookie: string | null;
}

/**
 * 一次请求的身份解析：
 * - 登录 → u:<userId>（档案跟随账号，注册迁移见 docs/03 §4）
 * - 游客 → g:<有效 cookie id>；无/坏 cookie 且有 IP 时种新 cookie（下一请求起稳定）。
 *   连 IP 都拿不到（罕见）仍给种新 cookie：首请求无法落库，前端重试即稳定。
 */
export async function resolveIdentity(request: {
  headers: Headers;
  cookies: { get(name: string): { value: string } | undefined };
}): Promise<RequestIdentity> {
  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user as { id: string } | undefined;
  if (user?.id) return { key: `u:${user.id}`, userId: user.id, newGuestCookie: null };

  const cookieId = request.cookies.get(GUEST_ID_COOKIE)?.value;
  if (isValidGuestId(cookieId)) return { key: `g:${cookieId}`, userId: null, newGuestCookie: null };

  const fresh = newGuestId();
  return { key: `g:${fresh}`, userId: null, newGuestCookie: guestCookieHeader(fresh) };
}
