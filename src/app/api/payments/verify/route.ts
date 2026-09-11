import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { applyPaymentEvent, } from '@/lib/payments/engine';
import { getDefaultProvider, getEnabledProvider } from '@/lib/payments/registry';
import type { PaymentProvider } from '@/lib/payments/types';

// GET /api/payments/verify?checkout_id=xxx[&provider=creem]：支付成功页的权益回查
//（多平台通用）。
//
// 为什么有了 webhook 还要这个：本地开发（localhost）收不到平台 webhook，
// 没有它测试模式走不通流程。生产上它作为兜底——用户付完钱被回跳到
// /vip?checkout_id=...&provider=... 时立即生效，不用等 webhook。
//
// provider 参数由 checkout 路由在 success_url 里追加；缺省回退第一个启用平台
//（单平台期恒命中）。归属校验：只给"结账时埋的 referenceId 是当前登录用户"
// 或"结账邮箱 = 当前用户邮箱"的会话发权益，防止拿别人的 checkout_id 领会员。
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user as { id: string; email?: string } | undefined;
  if (!user) {
    return NextResponse.json({ code: 'NOT_AUTHENTICATED', error: '请先登录' }, { status: 401 });
  }

  const checkoutId = request.nextUrl.searchParams.get('checkout_id');
  if (!checkoutId) {
    return NextResponse.json({ code: 'BAD_REQUEST', error: '缺少 checkout_id' }, { status: 400 });
  }

  const provider: PaymentProvider | null =
    getEnabledProvider(request.nextUrl.searchParams.get('provider') ?? '') ??
    getDefaultProvider();
  if (!provider) {
    return NextResponse.json({ code: 'NOT_CONFIGURED', error: '支付未配置' }, { status: 500 });
  }

  try {
    const checkoutSession = await provider.fetchSession(checkoutId);
    if (!checkoutSession) {
      return NextResponse.json({ code: 'NOT_FOUND', error: '支付会话不存在' }, { status: 404 });
    }

    // 未支付/支付中：如实返回，前端提示稍后刷新
    if (!checkoutSession.complete) {
      return NextResponse.json({ granted: false, status: 'pending' });
    }

    // 归属校验（referenceId 优先，邮箱兜底；邮箱 lower() 比较——
    // 平台侧录入的大小写不一定与本站一致）
    const owned =
      (checkoutSession.referenceId && checkoutSession.referenceId === user.id) ||
      (checkoutSession.customerEmail &&
        checkoutSession.customerEmail.toLowerCase() === (user.email ?? '').toLowerCase());
    if (!owned) {
      return NextResponse.json(
        { code: 'FORBIDDEN', error: '该支付不属于当前账号' },
        { status: 403 }
      );
    }

    if (!checkoutSession.subscriptionId) {
      // 仅订阅制：没有订阅 id 的结账不授权益
      return NextResponse.json({ granted: false, status: 'no-subscription' });
    }

    const grantedTo = await applyPaymentEvent(provider, {
      type: 'grant',
      referenceId: checkoutSession.referenceId,
      customerId: checkoutSession.customerId,
      customerEmail: checkoutSession.customerEmail,
      subscriptionId: checkoutSession.subscriptionId,
      providerStatus: null, // 账期/状态由引擎向平台反查补齐
      periodEnd: checkoutSession.periodEnd,
    });

    if (!grantedTo) {
      return NextResponse.json(
        { code: 'VERIFY_FAILED', error: '核实支付状态失败，请稍后再试' },
        { status: 502 }
      );
    }

    return NextResponse.json({ granted: true, provider: provider.id });
  } catch (error) {
    console.error('[api/payments/verify] failed:', error);
    return NextResponse.json(
      { code: 'VERIFY_FAILED', error: '核实支付状态失败，请稍后再试' },
      { status: 502 }
    );
  }
}
