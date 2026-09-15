// /[locale]/vip：VIP 订阅（MVP 唯一付费入口；旅程内容对所有人开放，VIP 卖的是
// 更深、更久的陪伴——docs/02 §7）。
// 三态：未登录（订阅前置）/ 免费登录（权益清单 + 订阅）/ VIP 生效中（到期 + 管理订阅）。
// Creem 回跳 /vip?checkout_id=...&provider=...：客户端回查 /api/payments/verify 立即生效
//（本地无公网收不到 webhook 也能打通流程）。支付未配置时优雅降级（M8 上线前配 key）。
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { auth } from '@/lib/auth';
import { requireSignedIn } from '@/lib/identity';
import { getEntitlement } from '@/lib/entitlements';
import { getDefaultProvider } from '@/lib/payments/registry';
import VipView from '@/components/VipView';

export const dynamic = 'force-dynamic';

export default async function vipPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ checkout_id?: string; provider?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
  await requireSignedIn(locale, `/${locale}/vip`);

  const session = await auth.api.getSession({ headers: await headers() });
  const user = session?.user as { id: string } | undefined;
  const entitlement = user ? await getEntitlement(user.id) : null;
  const isVip = Boolean(entitlement?.vipUntil && new Date(entitlement.vipUntil) > new Date());
  const providerConfigured = Boolean(getDefaultProvider());

  const { checkout_id: checkoutId, provider } = await searchParams;

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.vip.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.vip.sub}</p>
      <p className="mt-1 text-xs text-ink-soft/70">{dict.vip.noContentWall}</p>
      <div className="mt-8">
        <VipView
          locale={locale}
          isVip={isVip}
          vipUntil={entitlement?.vipUntil ?? null}
          providerConfigured={providerConfigured}
          checkoutId={checkoutId ?? null}
          providerParam={provider ?? null}
          dict={dict.vip}
        />
      </div>
    </div>
  );
}
