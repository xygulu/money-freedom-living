// /[locale]/journal：金钱心事（日记 + VIP AI 回应，docs/02 §1）。
// 写/存免费所有人可用；回应是 VIP 功能（付费墙触发点②："写完想被回应时"，soft gate 文案）。
import { headers, cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { resolveIdentity } from '@/lib/identity';
import { getJournalEntries } from '@/lib/journal';
import { getQuotaStatus, clientIpFromHeaders, guestKeyForRequest, GUEST_ID_COOKIE } from '@/lib/quota';
import { timeZoneFrom, todayIn } from '@/lib/time';
import JournalView from '@/components/JournalView';

export const dynamic = 'force-dynamic';

export default async function journalPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  const headersList = await headers();
  const cookieList = await cookies();
  const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
  const entries = await getJournalEntries(identity.key);

  // 日界线按用户所在时区，不按服务器：游客 key 与配额桶都得用同一个「今天」
  const today = todayIn(timeZoneFrom(cookieList));

  const guest = guestKeyForRequest(
    cookieList.get(GUEST_ID_COOKIE)?.value,
    clientIpFromHeaders(headersList),
    today
  );
  const quota = await getQuotaStatus({ userId: identity.userId, guestKey: guest.guestKey, day: today });

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.journal.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.journal.sub}</p>
      <p className="mt-1 text-xs text-ink-soft/70">{dict.common.aiNotice}</p>
      <div className="mt-8">
        <JournalView locale={locale} isVip={quota.isVip} entries={entries} dict={dict.journal} />
      </div>
    </div>
  );
}
