// /[locale]/unsubscribe：退订确认页 + 落地页（M11-E）。
//
// 一页两态：
//   带 token（从信里点过来）—— 问一句「真要退吗」，按钮 POST 出去才算数。
//     这一步不是挽留，是防误退：邮件客户端会替用户预取链接，只有人按得动这个按钮。
//   带 ok（退订完成）—— 只说两件事：信不会再来了，你留在这儿的东西没动过。
//
// 退订之后最要紧的一句话不是「已退订」，是「你的东西一样不少」——
// 一个人点退订的时候，心里多半在想「我是不是要把这儿关掉了」。所以这一页
// 不挽留，不问原因，不给「再想想」。
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { getUiVersion, withJourneyHref } from '@/lib/ui-version';

export const dynamic = 'force-dynamic';

export default async function unsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ ok?: string; token?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = withJourneyHref(getDict(locale), locale, await getUiVersion());
  const sp = await searchParams;
  const t = dict.touch;

  // 还没退、手上有 token：先问一句
  if (sp.ok === undefined && sp.token) {
    return (
      <div className="flex flex-col pt-16" data-unsub-result="confirm">
        <h1 className="text-2xl font-medium tracking-tight">{t.unsubConfirmTitle}</h1>
        <p className="mt-5 text-sm leading-relaxed">{t.unsubConfirmBody}</p>
        {/* 原生 form：没有 JS 也退得掉。退订这件事不该有任何前置条件 */}
        <form method="post" action={`/api/touch/unsubscribe?locale=${locale}`} className="mt-8">
          <input type="hidden" name="token" value={sp.token} />
          <button
            type="submit"
            className="rounded-full border border-line px-5 py-2 text-sm text-ink-soft transition hover:border-accent hover:text-accent"
          >
            {t.unsubConfirmButton}
          </button>
        </form>
        <div className="mt-10 text-sm">
          <Link href={dict.nav.journeyHref} className="text-accent underline underline-offset-4">
            {t.unsubKeepLabel}
          </Link>
        </div>
      </div>
    );
  }

  const ok = sp.ok !== '0';
  return (
    <div className="flex flex-col pt-16" data-unsub-result={ok ? 'ok' : 'fail'}>
      <h1 className="text-2xl font-medium tracking-tight">{ok ? t.unsubTitle : t.settingLabel}</h1>
      <p className="mt-5 text-sm leading-relaxed">{ok ? t.unsubDone : t.unsubFail}</p>
      {ok && <p className="mt-3 text-xs leading-relaxed text-ink-soft/70">{t.unsubResubHint}</p>}
      <div className="mt-10 flex gap-4 text-sm">
        <Link href={dict.nav.journeyHref} className="text-accent underline underline-offset-4">
          {dict.nav.journey}
        </Link>
        <Link href={`/${locale}/me`} className="text-ink-soft underline underline-offset-4">
          {dict.nav.me}
        </Link>
      </div>
    </div>
  );
}
