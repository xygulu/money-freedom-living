import { NextRequest, NextResponse } from 'next/server';
import { applyPaymentEvent } from '@/lib/payments/engine';
import { listEnabledProviders } from '@/lib/payments/registry';

// POST /api/payments/webhook：所有支付平台共用的事件入口（多平台通用）。
// Creem Dashboard 已注册本地址；新平台无需新路由——注册表遍历各已启用平台
// 做验签探测，谁验签通过归谁（形状校验保证不会被别家平台误解释）。
//
// 纪律（adapter 契约，见 src/lib/payments/types.ts）：
// - fail-closed：secret 未配置的平台不参与探测；全平台验签失败 → 400
// - 验签通过但事件不认识/无法归属用户 → 200（平台停止重试，日志留痕人工排查）
// - 仅瞬时 DB 错误 → 5xx（让平台按策略重试：30s/5m/30m/6h）
export async function POST(request: NextRequest) {
  const raw = await request.text();
  const providers = listEnabledProviders();

  let event = null;
  let matched: string | null = null;
  for (const provider of providers) {
    try {
      // 返回事件 = 验签通过且需要处理；返回 null = 验签通过但不处理（refund 等）
      event = await provider.parseWebhook(raw, request.headers);
      matched = provider.id;
      break;
    } catch {
      // 该平台验签失败：继续探测下一个平台（secret 配重时靠形状校验兜底）
      continue;
    }
  }

  if (matched === null) {
    console.error('[api/payments/webhook] 所有平台验签均失败');
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }
  if (event === null) {
    // 验签通过但不认识/不处理（refund、样例事件等）
    return NextResponse.json({ received: true });
  }

  const provider = providers.find((p) => p.id === matched)!;
  try {
    await applyPaymentEvent(provider, event);
  } catch (error) {
    console.error(`[api/payments/webhook] 处理 ${matched} 事件失败:`, error);
    return NextResponse.json({ error: 'processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
