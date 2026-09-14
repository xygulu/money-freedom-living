// /[locale]/me：我的。画像入口 + VIP 入口 + 登录态 +（登录后）账户区：
// 恢复码 / 数据导出 / 删除账号（M7，docs/02 §9 合规清单的"用户权利"三件套）。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { auth } from '@/lib/auth';
import { resolveIdentity } from '@/lib/identity';
import { getEntitlement } from '@/lib/entitlements';
import { getProfile } from '@/lib/profile';
import MeAccount from '@/components/MeAccount';
import TouchOptIn from '@/components/TouchOptIn';

export const dynamic = 'force-dynamic';

export default async function mePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  const headersList = await headers();
  const session = await auth.api.getSession({ headers: headersList });
  const user = session?.user as { id: string; email?: string } | undefined;
  const entitlement = user ? await getEntitlement(user.id) : null;
  const isVip = Boolean(entitlement?.vipUntil && new Date(entitlement.vipUntil) > new Date());
  // 游客也有档案（g: key）——画像入口对所有人可用
  const identity = await resolveIdentity({ headers: headersList, cookies: await cookies() });
  const profile = await getProfile(identity.key);
  const hasPortrait = Boolean(profile?.portrait);

  const rows: { href: string; label: string; hint: string }[] = [
    {
      href: `/${locale}/portrait`,
      label: dict.me.portrait,
      hint: hasPortrait ? dict.me.portraitDone : dict.me.portraitEmpty,
    },
    {
      href: `/${locale}/vip`,
      label: dict.me.vip,
      hint: isVip ? dict.me.vipActive : dict.me.vipFree,
    },
  ];

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.me.title}</h1>
      {user?.email && <p className="mt-2 text-sm text-ink-soft">{user.email}</p>}
      {!user && (
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {dict.me.guestNote}{' '}
          <Link href={`/${locale}/login`} className="text-accent underline underline-offset-4">
            {dict.me.loginLink}
          </Link>
        </p>
      )}

      <ul className="mt-8 flex flex-col">
        {rows.map((row) => (
          <li key={row.href} className="border-t border-line">
            <Link href={row.href} className="flex flex-col gap-1 py-5">
              <span className="text-base">{row.label}</span>
              <span className="text-sm text-ink-soft">{row.hint}</span>
            </Link>
          </li>
        ))}
      </ul>

      {/* 节点来信的开关只对登录用户有意义——游客没有邮箱，发不了也不该问 */}
      {user && <TouchOptIn dict={dict} initialOptIn={profile?.touch?.emailOptIn === true} />}

      {user ? (
        <MeAccount locale={locale} dict={dict} />
      ) : (
        <p className="mt-10 text-xs leading-relaxed text-ink-soft/70">
          {dict.me.recoveryNote}{' '}
          <a href={`/${locale}/privacy`} className="underline underline-offset-4">
            {dict.me.privacyLink}
          </a>
        </p>
      )}
    </div>
  );
}
