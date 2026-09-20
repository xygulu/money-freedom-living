// POST /api/chat/sessions：发起一次对话（kind=chat 正式对话 | kind=companion 陪伴者弹层，2026-09-18）。
// 配额语义（P§7）：此处只做预检，不落账——"1 次 = 一次对话会话"，真正的落账
// 发生在 /api/chat/[id] 首条 AI 回复成功后（失败不扣、会话内重试不扣）。
// 进入时惰性结算上次未收尾的会话（摘要入 memories），这是"第二天它还记得你"的兜底。
// 惰性结算只针对 kind=chat（findOpenChatSession 硬编）——companion 弹层会话不写 memory，
// 留给它自己的 DELETE / 10 轮收尾关闭。
import { NextRequest } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { createSession, findOpenChatSession, findOpenCompanionSession, type SessionKind } from '@/lib/chat';
import { settleSession } from '@/lib/memory';
import { getQuotaStatus, clientIpFromHeaders, guestKeyForRequest, guestCookieHeader, GUEST_ID_COOKIE } from '@/lib/quota';
import { timeZoneFrom, todayIn } from '@/lib/time';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）。
    // companion 也被这道闸挡住：必须登录（球挂在 /journey-new，访客本就 302）
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;
    const identity = auth.identity;

    const body = (await request.json().catch(() => ({}))) as { locale?: string; kind?: string };
    const locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';
    // kind 白名单：只接受 chat / companion；缺省 chat（旧客户端兼容）
    const kind: SessionKind = body.kind === 'companion' ? 'companion' : 'chat';

    // 惰性结算：上次正式对话若没走"结束"流程（直接关页面/轮数未到），在此补摘要并关闭。
    // settleSession 内部 best-effort，LLM 失败也会关会话，不阻塞新会话。
    // findOpenChatSession 只找 kind=chat——companion 会话不被惰性结算。
    const stale = await findOpenChatSession(identity.key);
    if (stale) await settleSession(identity.key, locale, stale.id, timeZoneFrom(request.cookies));

    // 配额预检：游客 1/日、免费 3/日、VIP 充裕（quota.ts 三档常量）。
    // companion 与 chat 共桶（用户 2026-09-18 拍板：不区分 quota kind）。
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

    // companion 复用 open 会话：弹层反复开合不堆积 open companion 行
    if (kind === 'companion') {
      const existing = await findOpenCompanionSession(identity.key);
      if (existing) {
        const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
        if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
        else if (guest.newCookieId) headers['Set-Cookie'] = guestCookieHeader(guest.newCookieId);
        return Response.json({ session: existing.id, reused: true }, { headers });
      }
    }

    const session = await createSession({ userKey: identity.key, locale, kind });
    await track(identity.key, 'chat_session_started', { kind }, locale);
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    else if (guest.newCookieId) headers['Set-Cookie'] = guestCookieHeader(guest.newCookieId);
    return Response.json({ session: session.id }, { headers });
  } catch (error) {
    console.error('[api/chat/sessions] failed:', error);
    return jsonError('server_error', 500);
  }
}
