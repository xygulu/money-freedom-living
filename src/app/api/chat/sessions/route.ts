// POST /api/chat/sessions：发起一次正式对话（kind=chat）。
// 配额语义（P§7）：此处只做预检，不落账——"1 次 = 一次对话会话"，真正的落账
// 发生在 /api/chat/[id] 首条 AI 回复成功后（失败不扣、会话内重试不扣）。
// 进入时惰性结算上次未收尾的会话（摘要入 memories），这是"第二天它还记得你"的兜底。
import { NextRequest } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { createSession, findOpenChatSession } from '@/lib/chat';
import { settleSession } from '@/lib/memory';
import { getQuotaStatus, clientIpFromHeaders, guestKeyForRequest, guestCookieHeader, GUEST_ID_COOKIE } from '@/lib/quota';
import { timeZoneFrom, todayIn } from '@/lib/time';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;
    const identity = auth.identity;

    const body = (await request.json().catch(() => ({}))) as { locale?: string };
    const locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';

    // 惰性结算：上次对话若没走"结束"流程（直接关页面/轮数未到），在此补摘要并关闭。
    // settleSession 内部 best-effort，LLM 失败也会关会话，不阻塞新会话。
    const stale = await findOpenChatSession(identity.key);
    if (stale) await settleSession(identity.key, locale, stale.id, timeZoneFrom(request.cookies));

    // 配额预检：游客 1/日、免费 3/日、VIP 充裕（quota.ts 三档常量）。
    // 用完时返回 403 + 档位状态，前端展示付费墙文案①（"今天先到这里，VIP 随时继续"）。
    // 日界线按用户所在时区，不按服务器：游客 key 与配额桶都得用同一个「今天」
    const today = todayIn(timeZoneFrom(request.cookies));
    const guest = guestKeyForRequest(
      request.cookies.get(GUEST_ID_COOKIE)?.value,
      clientIpFromHeaders(request.headers),
      today
    );
    const status = await getQuotaStatus({ userId: identity.userId, guestKey: guest.guestKey, day: today });
    if (status.remaining <= 0) {
      return jsonError('quota_exhausted', 403, { limit: String(status.limit), used: String(status.used) });
    }

    const session = await createSession({ userKey: identity.key, locale, kind: 'chat' });
    await track(identity.key, 'chat_session_started', {}, locale);
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    else if (guest.newCookieId) headers['Set-Cookie'] = guestCookieHeader(guest.newCookieId);
    return Response.json({ session: session.id }, { headers });
  } catch (error) {
    console.error('[api/chat/sessions] failed:', error);
    return jsonError('server_error', 500);
  }
}
