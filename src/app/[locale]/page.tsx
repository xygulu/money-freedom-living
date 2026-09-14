// /[locale]：落地页——只给还没体检过的访客看。已体检（画像存在）的访问直接
// 进旅程：回访者要的是「今天」，不是再读一遍招牌（用户反馈：做过体检进来
// 还是体检首页）。体检与否的判定是 portrait 存在（仅有档案行不算——如只在
// 旅程页记过一条真实记录但没体检的访客，仍应看到体检入口）。
//
// 前台改造（70-2 A1）：已体检回访者按 ui_version 重定向：
//   - new      → /journey-new（一幕）
//   - classic  → /journey  （经典版）
// 落地页本体仅在没体检时渲染。
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

  // 已体检 → 旅程（按 ui_version 选新版或经典版）。
  try {
    const headersList = await headers();
    const cookieList = await cookies();
    const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
    const profile = await getProfile(identity.key);
    if (profile?.portrait) {
      const v = await getUiVersion();
      redirect(journeyHrefFor(locale, v));
    }
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

  return (
    <div className="flex flex-col pt-20">
      <h1 className="text-3xl leading-snug font-medium tracking-tight">{dict.landing.hero}</h1>

      <p className="mt-6 text-base leading-relaxed text-ink-soft">{dict.landing.sub}</p>

      <Link
        href={`/${locale}/onboarding`}
        className="mt-10 inline-block rounded-full bg-accent px-8 py-4 text-center text-base text-paper transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ink"
      >
        {dict.landing.cta}
      </Link>

      <p className="mt-4 text-sm text-ink-soft">{dict.landing.privacy}</p>

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
