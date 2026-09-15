// /[locale]/timeline：成长足迹（M9 需求①）。画像、对话摘要、日记、信、微行动、
// 心印归并成一条时间线——「改变不是一瞬间，是回头才看见的一步步」。
// 全部只读；对话回看页见 /chat/history。零 LLM 成本。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { requireSignedIn } from '@/lib/identity';
import { buildTimeline, formatTimelineDay, type TimelineItem } from '@/lib/timeline';
import { getUiVersion, withJourneyHref } from '@/lib/ui-version';
import TimelineItemView from '@/components/TimelineItemView';

export const dynamic = 'force-dynamic';

const todayISO = () => new Date().toISOString().slice(0, 10);

export default async function timelinePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = withJourneyHref(getDict(locale), locale, await getUiVersion());

  // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
  const identity = await requireSignedIn(locale, `/${locale}/timeline`);
  const headersList = await headers();
  const cookieList = await cookies();
  const items = await buildTimeline(identity.key);

  // 按日期分组（同日连续归一组），今天给一个「今天」的抬头
  const today = todayISO();
  const groups: { date: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.date === item.date) last.items.push(item);
    else groups.push({ date: item.date, items: [item] });
  }

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.timeline.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.timeline.sub}</p>
      <p className="mt-1 text-xs text-ink-soft/70">{dict.common.aiNotice}</p>

      {groups.length === 0 ? (
        <div className="mt-8 border border-dashed border-line p-6">
          <p className="text-sm leading-relaxed text-ink-soft">{dict.timeline.empty}</p>
          <Link
            href={dict.nav.journeyHref}
            className="mt-5 inline-block border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper"
          >
            {dict.timeline.backToJourney}
          </Link>
        </div>
      ) : (
        <div className="mt-8">
          {groups.map((group) => (
            <section key={group.date} className="mt-8 first:mt-0">
              <h2 className="text-xs tracking-widest text-ink-soft">
                {group.date === today ? `${dict.timeline.today} · ` : ''}
                {formatTimelineDay(locale, group.date)}
              </h2>
              <ul className="mt-2 flex flex-col">
                {group.items.map((item, i) => (
                  <li key={`${group.date}-${item.kind}-${i}`} className="border-t border-line py-5 first:border-t-0">
                    <TimelineItemView item={item} locale={locale} dict={dict} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
