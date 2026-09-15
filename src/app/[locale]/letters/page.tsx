// /[locale]/letters：信件基础闭环（写/存/AI 回信/封存开启简版，docs/02 MVP 范围）。
// 阶段仪式：阶段 1「给现在的自己」、阶段 2「写给钱的一封信」——入口从旅程页来。
// 回信原则（docs/02）：承接情绪、确认收到，但不分析、不解读、不给建议。
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { requireSignedIn } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import LettersView from '@/components/LettersView';

export const dynamic = 'force-dynamic';

export default async function lettersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
  const identity = await requireSignedIn(locale, `/${locale}/letters`);
  const cookieList = await cookies();
  const profile = await getProfile(identity.key);

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.letters.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.letters.sub}</p>
      <p className="mt-1 text-xs text-ink-soft/70">{dict.common.aiNotice}</p>
      <div className="mt-8">
        <LettersView locale={locale} letters={profile?.letters ?? []} dict={dict.letters} />
      </div>
    </div>
  );
}
