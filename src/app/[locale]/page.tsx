// /[locale]：落地页。
//
// 四态分支（用户 2026-09-14 拍板）：
// - 已登录 + 有画像 → redirect 到旅程页（按 ui_version 分流）
// - 已登录 + 无画像 → redirect 到 onboarding
// - 访客   + 有画像 → 钩子 + "看你的画像" CTA + "登录 / 注册" CTA
// - 访客   + 无画像 → 钩子 + "看看你和钱的关系" CTA + "登录 / 注册" CTA
//
// 钩子 + 双 CTA：访客进来第一眼不是营销页——是一句引起兴趣的话 + 两个动作。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { visibleLocales } from '@/i18n/config';
import { getDict } from '@/i18n/get-dict';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import { getUiVersion, journeyHrefFor } from '@/lib/ui-version';

export const dynamic = 'force-dynamic';

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const dict = getDict(locale);

  let isSignedIn = false;
  let hasPortrait = false;
  try {
    const headersList = await headers();
    const cookieList = await cookies();
    const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
    isSignedIn = Boolean(identity.userId);
    const profile = await getProfile(identity.key);
    hasPortrait = Boolean(profile?.portrait);
  } catch (error) {
    // redirect() 以特殊错误对象向外抛，必须放行；身份/档案解析失败 = 当作访客
    if (
      error &&
      typeof error === 'object' &&
      'digest' in error &&
      typeof (error as { digest?: string }).digest === 'string' &&
      (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
    ) {
      throw error;
    }
    console.error('[landing] identity/profile resolve failed:', error instanceof Error ? error.message : error);
  }

  if (isSignedIn) {
    const v = await getUiVersion();
    redirect(hasPortrait ? journeyHrefFor(locale, v) : `/${locale}/onboarding`);
  }

  // 访客态：钩子 + 双 CTA
  const primaryHref = hasPortrait ? `/${locale}/portrait` : `/${locale}/onboarding`;
  const primaryLabel = hasPortrait ? dict.landing.ctaPortrait : dict.landing.ctaTest;
  const signInHref = `/${locale}/login?next=${encodeURIComponent(primaryHref)}`;

  return (
    <div className="flex flex-col pt-20">
      <h1
        className="text-3xl leading-snug font-medium tracking-tight"
        data-landing-hook
      >
        {dict.landing.hook}
      </h1>

      <p className="mt-6 text-base leading-relaxed text-ink-soft">
        {dict.landing.hookSub}
      </p>

      <Link
        href={primaryHref}
        data-landing-cta-test
        className="mt-10 inline-block rounded-full bg-accent px-8 py-4 text-center text-base text-paper transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ink"
      >
        {primaryLabel}
      </Link>

      <Link
        href={signInHref}
        data-landing-cta-signin
        className="mt-4 inline-block text-center text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
      >
        {dict.landing.ctaSignIn}
      </Link>

      <p className="mt-12 text-sm text-ink-soft">{dict.landing.privacy}</p>

      <p className="mt-16 border-t border-line pt-6 text-xs leading-relaxed text-ink-soft">
        {dict.common.aiNotice}
      </p>

      <p className="mt-4 text-xs">
        <a href={`/${locale}/privacy`} className="text-ink-soft underline underline-offset-4">
          {dict.me.privacyLink}
        </a>
      </p>

      <ul className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {visibleLocales.map(({ code, label, enabled }) => (
          <li key={code}>
            {code === locale ? (
              <span className="text-ink underline underline-offset-4">{label}</span>
            ) : enabled ? (
              <Link href={`/${code}`} className="text-ink-soft hover:text-ink hover:underline">
                {label}
              </Link>
            ) : (
              <span className="text-ink-soft/60">
                {label} · {dict.common.comingSoon}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}