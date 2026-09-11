import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getLatestLiveSubscription } from '@/lib/entitlements';
import { getEnabledProvider } from '@/lib/payments/registry';

// POST /api/payments/portal：生成客户自助管理门户链接（改支付方式/取消订阅/看发票）。
// 需要本站有该用户的订阅记录（subscriptions 表反查 provider + customer id）；
// body.provider 可选指定平台，缺省用用户最近一条订阅所属的平台。
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user as { id: string } | undefined;
  if (!user) {
    return NextResponse.json({ code: 'NOT_AUTHENTICATED', error: '请先登录' }, { status: 401 });
  }

  try {
    const subscription = await getLatestLiveSubscription(user.id);
    if (!subscription?.providerCustomerId) {
      return NextResponse.json(
        { code: 'NO_SUBSCRIPTION', error: '还没有订阅记录，先开通 VIP 吧' },
        { status: 400 }
      );
    }

    const provider = getEnabledProvider(subscription.provider);
    if (!provider?.createPortalUrl) {
      return NextResponse.json(
        { code: 'PORTAL_FAILED', error: '订阅管理暂不可用，请稍后再试' },
        { status: 502 }
      );
    }

    const url = await provider.createPortalUrl({
      userId: user.id,
      providerCustomerId: subscription.providerCustomerId,
    });
    return NextResponse.json({ url });
  } catch (error) {
    console.error('[api/payments/portal] failed:', error);
    return NextResponse.json(
      { code: 'PORTAL_FAILED', error: '打开订阅管理失败，请稍后再试' },
      { status: 502 }
    );
  }
}
