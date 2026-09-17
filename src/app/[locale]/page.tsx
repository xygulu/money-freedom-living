// /[locale]：落地页。
//
// 三态分支（用户 2026-09-17 拍板·v2）：
// - 已登录 + 真完成画像（baseColor + script 都非空）→ redirect 到旅程页（按 ui_version 分流）
// - 已登录 + 无画像/半填画像 → redirect 到 onboarding
// - 访客（不管有没有画像）→ 钩子 + 主 CTA "看看我和金钱的关系"（永远统一文案）+ 副 CTA "登录 / 注册"
//
// 主 CTA 文案永远 dict.landing.ctaTest（"看看我和金钱的关系"），href 按 hasCompletedPortrait 分流：
//   - 访客+真完成画像 → /portrait（点击后"显示画像"）
//   - 访客+无画像/半填画像 → /onboarding（点击后"直接开始测试题"，无中间页跳转）
//
// "真完成画像"判断与 /portrait/page.tsx 严格口径一致（baseColor && script 都非空）；
// 半填画像（{baseColor:'', script:'', spoken:[]}）不算——避免访客被推到 /portrait "开始体检"中间页。
// 用户原话（2026-09-17）："首页按钮改成 看看我和金钱的关系 点击后直接开始第一题，不要中间再有页面跳转"
// 用户原话（2026-09-17）："如果有金钱关系画像就显示画像，如果没有就直接开始测试题"——描述点击行为，不分 CTA 文案。
// 用户原话（2026-09-17）："点击这个按钮后直接开始测试进入第一题，去掉 开始体检 这个中间页"——半填画像也走 /onboarding。
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
  let hasCompletedPortrait = false;
  try {
    const headersList = await headers();
    const cookieList = await cookies();
    const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
    isSignedIn = Boolean(identity.userId);
    const profile = await getProfile(identity.key);
    // 与 /portrait/page.tsx 严格口径一致：只有真正完成画像（baseColor + script 都非空）
    // 才算"有画像"；空 portrait 对象（如 {baseColor:'', script:'', spoken:[]}）不算——
    // 这种"半填"状态也走 /onboarding 直接进 form 第一题，**不再推到 /portrait 中间页**。
    hasCompletedPortrait = Boolean(profile?.portrait?.baseColor && profile?.portrait?.script);
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
    redirect(hasCompletedPortrait ? journeyHrefFor(locale, v) : `/${locale}/onboarding`);
  }

  // 访客态：钩子 + 双 CTA
  // v2（用户 2026-09-17 拍板）：主 CTA 文案永远统一"看看我和金钱的关系"（dict.landing.ctaTest），
  // href 按 hasCompletedPortrait（baseColor + script 都非空）分流——访客+真完成画像 → /portrait（点击后显示画像）；
  // 访客+无画像/半填画像 → /onboarding（点击后直接 form 第一题，无中间页）。
  // 这条规则复刻了首页按钮的"测试/重新测试"语义：所有访客的主入口都是同一个 CTA，不让"看你的画像"
  // 与"看看我和金钱的关系"在 landing 上同时出现，避免用户被两条分支带去不同页面。
  const primaryHref = hasCompletedPortrait ? `/${locale}/portrait` : `/${locale}/onboarding`;
  const primaryLabel = dict.landing.ctaTest;
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