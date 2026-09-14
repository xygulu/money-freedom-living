import type { Metadata } from 'next';
import Link from 'next/link';
import { headers, cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import '../globals.css';
import { enabledLocales, htmlLang, isLocale } from '@/i18n/config';
import { getDict } from '@/i18n/get-dict';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import JourneyProgressBar from '@/components/JourneyProgressBar';

export const metadata: Metadata = {
  title: 'Money Freedom Living',
  description: 'A room of your own, for everything money makes you feel.',
};

export function generateStaticParams() {
  return enabledLocales.map((locale) => ({ locale }));
}

export const dynamic = 'force-dynamic'; // 进度条需要身份与档案（cookies）——全站数据页本就动态

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();

  const dict = getDict(locale);

  // 全局进度条数据（用户需求：所有页面固定可见）。layout 绝不因进度条挂掉：
  // 任何失败（无档案/DB 抖动/身份解析异常）都按 null 处理 → 进度条不渲染。
  let profile = null;
  try {
    const headersList = await headers();
    const cookieList = await cookies();
    const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
    profile = await getProfile(identity.key);
  } catch (error) {
    console.error('[layout] progress bar profile failed:', error);
  }

  const tabs = [
    { href: `/${locale}/journey`, label: dict.nav.journey },
    { href: `/${locale}/chat`, label: dict.nav.chat },
    { href: `/${locale}/journal`, label: dict.nav.journal },
    { href: `/${locale}/me`, label: dict.nav.me },
  ];

  return (
    <html lang={htmlLang(locale)}>
      <head>
        {/* 把浏览器报的 IANA 时区写进 cookie，服务端据此算「今天」并告诉 AI 现在几点。
            内联脚本而不是组件：要在 hydration 之前就跑完，首屏之后的每个请求都带得上。
            第一次访问的那个请求还没有 cookie（服务端回落 UTC）；用户换城市时自动刷新。 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=Intl.DateTimeFormat().resolvedOptions().timeZone;" +
              "var m=document.cookie.match(/(?:^|; )mfl_tz=([^;]*)/);" +
              "if(t&&(!m||decodeURIComponent(m[1])!==t)){" +
              "document.cookie='mfl_tz='+encodeURIComponent(t)+';path=/;max-age=31536000;samesite=lax'}}catch(e){}",
          }}
        />
      </head>
      <body className="min-h-dvh antialiased">
        <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-5">
          <main className="flex-1">{children}</main>

          {/* 底部 sticky 容器：进度条在上、导航在下，一起贴底全页可见 */}
          <div className="sticky bottom-0 -mx-5 mt-10 border-t border-line bg-paper/95 backdrop-blur">
            <JourneyProgressBar locale={locale} dict={dict} profile={profile} />
            <nav aria-label="Main" className="grid grid-cols-4">
              {tabs.map((tab) => (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className="px-2 py-3 text-center text-sm text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {tab.label}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      </body>
    </html>
  );
}
