// /[locale]/unsubscribe：退订落地页（M11-E）。
//
// 退订之后最要紧的一句话不是「已退订」，是「你的东西一样不少」——
// 一个人点退订的时候，心里多半在想「我是不是要把这儿关掉了」。所以这一页只做两件事：
// 说清楚信不会再来了，说清楚他留在这儿的东西没动过。不挽留，不问原因，不给「再想想」。
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export default async function unsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ ok?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);
  const ok = (await searchParams).ok !== '0';

  return (
    <div className="flex flex-col pt-16" data-unsub-result={ok ? 'ok' : 'fail'}>
      <h1 className="text-2xl font-medium tracking-tight">{ok ? dict.touch.unsubTitle : dict.touch.settingLabel}</h1>
      <p className="mt-5 text-sm leading-relaxed">{ok ? dict.touch.unsubDone : dict.touch.unsubFail}</p>
      {ok && <p className="mt-3 text-xs leading-relaxed text-ink-soft/70">{dict.touch.unsubResubHint}</p>}
      <div className="mt-10 flex gap-4 text-sm">
        <Link href={`/${locale}/journey`} className="text-accent underline underline-offset-4">
          {dict.nav.journey}
        </Link>
        <Link href={`/${locale}/me`} className="text-ink-soft underline underline-offset-4">
          {dict.nav.me}
        </Link>
      </div>
    </div>
  );
}
