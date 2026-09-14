import type { Metadata } from 'next';
import { headers, cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import '../globals.css';
import '@/styles/scene-tokens.css';
import { enabledLocales, htmlLang, isLocale } from '@/i18n/config';
import { getDict } from '@/i18n/get-dict';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import { getUiVersion } from '@/lib/ui-version';
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
  const uiVersion = await getUiVersion();

  // 全局进度条数据（用户需求：所有页面固定可见）。layout 绝不因进度条挂掉：
  // 任何失败（无档案/DB 抖动/身份解析异常）都按 null 处理 → 进度条不渲染。
  // 经典版守卫：进度条只在 classic 路径渲染（新版 /journey-new 自带 PathBar）。
  let profile = null;
  try {
    const headersList = await headers();
    const cookieList = await cookies();
    const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
    profile = await getProfile(identity.key);
  } catch (error) {
    console.error('[layout] progress bar profile failed:', error);
  }

  return (
    <html lang={htmlLang(locale)} data-scene-theme="plain">
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

          {/* 前台改造（70-2 A1）· 底部 4 Tab 已移除。
              - 经典版路径（/journey 等老页）：仍渲染 JourneyProgressBar 给那些页面用
              - 新版路径：journey-new 自带 PathBar；本页 chat/journal/me 由各自页面承担入口
              目标骨架 = 1 真入口（/） + 1 存档（/archive） + 1 陪伴者（右下角常驻） */}
          {uiVersion === 'classic' && (
            <div className="sticky bottom-0 -mx-5 mt-10 border-t border-line bg-paper/95 backdrop-blur">
              <JourneyProgressBar locale={locale} dict={dict} profile={profile} />
              {/* 经典版仍保留底部 4 Tab（以维持经典版逐字原貌，迁移动作不在本批）
                  导航项用 dict.nav.*；aria-label=Main 与既有 smoke 锚点契约一致 */}
              <nav aria-label="Main" className="grid grid-cols-4" data-version-nav="classic">
                {[
                  { href: `/${locale}/journey`, label: dict.nav.journey },
                  { href: `/${locale}/chat`, label: dict.nav.chat },
                  { href: `/${locale}/journal`, label: dict.nav.journal },
                  { href: `/${locale}/me`, label: dict.nav.me },
                ].map((tab) => (
                  <a
                    key={tab.href}
                    href={tab.href}
                    className="px-2 py-3 text-center text-sm text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    {tab.label}
                  </a>
                ))}
              </nav>
            </div>
          )}

          {/* 陪伴者：仅 /journey-new 自己挂载（70-2 加固：todayStepDone 由 NewJourneyView 持有），
              经典版路径不显示（保持经典版逐字原貌）。 */}
        </div>
      </body>
    </html>
  );
}
