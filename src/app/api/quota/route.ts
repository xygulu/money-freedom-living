import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  getQuotaStatus,
  clientIpFromHeaders,
  guestKeyForRequest,
  guestCookieHeader,
  GUEST_ID_COOKIE,
} from '@/lib/quota';
import { timeZoneFrom, todayIn } from '@/lib/time';
import { getEntitlement, getLatestLiveSubscription } from '@/lib/entitlements';

// GET /api/quota：当前用户的配额 + 会员状态。
// 未登录也响应（游客配额），供前端显示剩余次数、VIP 标识。
//
// ⚠️ 缓存纪律（实测踩过）：配额随每次消耗实时变化、且按请求方身份返回不同
// 数据，必须 force-dynamic + no-store——否则任何一层缓存（浏览器/代理/CDN）
// 都会复用早前快照，页面显示的剩余次数滞后（"刚扣完还显示旧数字"）。
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    const user = session?.user as { id: string } | undefined;
    const userId = user?.id ?? null;

    // 游客身份：匿名 cookie 优先，IP 兜底（裸 IP 会因 v4/v6 双栈翻转分裂配额桶）
    // 日界线按用户所在时区，不按服务器：游客 key 与配额桶都得用同一个「今天」
    const today = todayIn(timeZoneFrom(request.cookies));
    const guest = guestKeyForRequest(
      request.cookies.get(GUEST_ID_COOKIE)?.value,
      clientIpFromHeaders(request.headers),
      today
    );
    const status = await getQuotaStatus({ userId, guestKey: guest.guestKey, day: today });

    // 会员详情（到期时间/订阅状态）仅登录用户需要。
    // subscription.status 是平台中立枚举（live/grace/ended），UI 一律消费
    // willCancel 布尔，不判断任何平台的原生状态字符串
    const entitlement = userId ? await getEntitlement(userId) : null;
    const subscription = userId ? await getLatestLiveSubscription(userId) : null;

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    // 只给游客种身份 cookie（登录用户按 user_id 计，不需要）
    if (!userId && guest.newCookieId) {
      headers['Set-Cookie'] = guestCookieHeader(guest.newCookieId);
    }

    return NextResponse.json(
      {
        ...status,
        vipUntil: entitlement?.vipUntil ?? null,
        subscription: subscription
          ? {
              provider: subscription.provider,
              status: subscription.status,
              willCancel: subscription.willCancel,
            }
          : null,
      },
      { headers }
    );
  } catch (error) {
    console.error('[api/quota] failed:', error);
    return NextResponse.json(
      { error: '查询配额失败' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
