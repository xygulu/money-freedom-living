import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { hasActiveSubscriptionOn } from '@/lib/entitlements';
import { track } from '@/lib/analytics';
import { getDefaultProvider, getEnabledProvider } from '@/lib/payments/registry';
import { PaymentProviderError } from '@/lib/payments/types';

// POST /api/payments/checkout：创建托管收银台会话（需登录，多平台通用）。
// body.provider 可选：指定平台 id；缺省用第一个启用的平台。
// 前端拿 { url, provider } 后整页跳转；支付完成平台回跳 success_url 并追加
// checkout_id 与 provider 参数，由 /vip 页回查权益（本地无公网收不到 webhook
// 也能打通流程）。
export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user as { id: string; email?: string } | undefined;
  if (!user?.email) {
    return NextResponse.json({ code: 'NOT_AUTHENTICATED', error: '请先登录后再订阅' }, { status: 401 });
  }

  let requested: string | null = null;
  try {
    const body = (await request.json()) as { provider?: unknown } | null;
    requested = typeof body?.provider === 'string' ? body.provider : null;
  } catch {
    // 无 body：用默认平台
  }

  const provider = (requested && getEnabledProvider(requested)) || getDefaultProvider();
  if (!provider) {
    console.error('[api/payments/checkout] 没有已启用的支付平台（检查 registry 中各平台 env 配置）');
    return NextResponse.json({ code: 'NOT_CONFIGURED', error: '支付未配置，请稍后再试' }, { status: 500 });
  }
  if (requested && provider.id !== requested) {
    return NextResponse.json(
      { code: 'UNKNOWN_PROVIDER', error: `支付平台 ${requested} 不可用` },
      { status: 400 }
    );
  }

  // 防重复订阅：同平台已有生效中（live/grace）的订阅再开一单 = 平台侧二次扣费。
  // 引导去门户管理（续费/撤销取消都在那里）。跨平台并存是设计允许的，不拦。
  if (await hasActiveSubscriptionOn(user.id, provider.id)) {
    return NextResponse.json(
      { code: 'ALREADY_SUBSCRIBED', error: '你已有生效中的订阅，可在"管理订阅"中查看' },
      { status: 400 }
    );
  }

  // 回跳地址：优先 BETTER_AUTH_URL（部署时的公网地址，dev 就是 localhost:3000）。
  // 追加 provider 参数：成功页回查（/api/payments/verify）据此直达对应 adapter
  const origin = process.env.BETTER_AUTH_URL || request.nextUrl.origin;
  const successUrl = `${origin}/vip?provider=${provider.id}`;

  // 验收指标：VIP 基线（转化漏斗起点）
  await track(`u:${user.id}`, 'checkout_started', { provider: provider.id });

  try {
    const checkout = await provider.createCheckout({
      userId: user.id,
      email: user.email,
      successUrl,
    });
    return NextResponse.json({ url: checkout.url, checkoutId: checkout.sessionId, provider: provider.id });
  } catch (error) {
    // 只认中立基类：各 adapter 的具体错误类都继承它，平台错误日志统一带 status/traceId
    if (error instanceof PaymentProviderError) {
      console.error('[api/payments/checkout] 平台错误:', provider.id, error.status, error.message, error.traceId);
    } else {
      console.error('[api/payments/checkout] failed:', error);
    }
    return NextResponse.json(
      { code: 'CHECKOUT_FAILED', error: '创建支付会话失败，请稍后再试' },
      { status: 502 }
    );
  }
}
