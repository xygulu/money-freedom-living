import { NextResponse } from 'next/server';
import { getDefaultProvider, listEnabledProviders } from '@/lib/payments/registry';

// GET /api/payments/config：前端可见的支付平台元数据（公开，无任何敏感信息）。
// 前端据此渲染平台相关文案（/vip 脚注）并解析平台回跳 URL 参数名——
// 接入新平台时前端零改动：这里返回什么，UI 就展示/消费什么。
// 返回 defaultProvider = null 表示当前没有已启用平台（前端隐藏订阅入口文案降级）。
export async function GET() {
  const providers = listEnabledProviders().map((p) => ({
    id: p.id,
    label: p.label,
    checkoutIdParam: p.checkoutIdParam,
    billingNote: p.billingNote ?? null,
  }));
  return NextResponse.json({
    providers,
    defaultProvider: getDefaultProvider()?.id ?? null,
  });
}
