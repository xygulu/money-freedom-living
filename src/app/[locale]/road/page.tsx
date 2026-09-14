// /[locale]/road：「你走过的路」（M11-D，docs/05 §3.5）。
//
// **书在整个产品里只在这一页露面**——当出处（这段路是从哪本书走过来的）和邀请
// （同一件事，还有别的书从另一个角度说过）。日常页、进度、灯、计数里一律没有书。
// 用户的心智锚点是命题，书只是他能选的入口。
//
// 陈列的是他自己的原话，不是结论：不写「你进步了」，不打分，不排名。还没走到的
// 命题单独一块，叫「还没走到的地方」——是远处的风景，不是欠账（docs/05 §8.1）。
// 全部只读，零 LLM 成本。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import { buildRoad, inviteBooksFor } from '@/lib/road';
import { bookTitle } from '@/lib/content';
import { formatTimelineDay } from '@/lib/timeline';

export const dynamic = 'force-dynamic';

export default async function roadPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  const headersList = await headers();
  const cookieList = await cookies();
  const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
  const profile = await getProfile(identity.key);
  const road = profile ? buildRoad(profile) : null;

  const topicName = (topic: string) => (dict.topics as unknown as Record<string, string>)[topic] ?? topic;
  const depthName = (depth: string) =>
    depth === 'mastered' ? dict.road.depthMastered : depth === 'replaced' ? dict.road.depthReplaced : dict.road.depthSeen;
  const day = (iso: string) => formatTimelineDay(locale, iso.slice(0, 10));

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.road.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.road.sub}</p>

      {!road || road.lines.length === 0 ? (
        <div className="mt-8 border border-dashed border-line p-6">
          <p className="text-sm leading-relaxed text-ink-soft">{dict.road.empty}</p>
          <Link
            href={`/${locale}/journey`}
            className="mt-5 inline-block border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper"
          >
            {dict.road.backToJourney}
          </Link>
        </div>
      ) : (
        <ul className="mt-8 flex flex-col">
          {road.lines.map((line) => {
            // 邀请只在这条线「在这本书里走完了」之后才拿出来——没走完就提别的书，
            // 是在推销，不是在陪他（docs/05 §3.4：看信号，不看进度）
            const invites = line.depth === 'mastered' ? inviteBooksFor(line.topic, profile!) : [];
            return (
              <li key={line.topic} data-road-line={line.topic} className="border-t border-line py-6">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 className="text-base font-medium">{topicName(line.topic)}</h2>
                  <span data-road-depth={line.depth} className="shrink-0 text-xs text-ink-soft">
                    {depthName(line.depth)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-soft/70">
                  {day(line.firstSeenAt)} – {day(line.lastSeenAt)}
                </p>

                {/* 物件上只放他自己的原话 */}
                {line.quotes.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs tracking-widest text-ink-soft">{dict.road.quotesLead}</p>
                    <ul className="mt-2 flex flex-col gap-2">
                      {line.quotes.map((q, i) => (
                        <li key={`${line.topic}-q-${i}`} className="border-l-2 border-accent/40 pl-3 text-sm leading-relaxed">
                          {q.quote}
                          <span className="mt-1 block text-xs text-ink-soft/60">{day(q.at)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* 书露面的第一处：出处 */}
                {line.sources.length > 0 && (
                  <p data-road-source className="mt-4 text-xs leading-relaxed text-ink-soft/70">
                    {dict.road.sourceLead}：{line.sources.map((id) => bookTitle(id, locale)).join(' · ')}
                  </p>
                )}

                {/* 书露面的第二处：邀请（v1 只有一本书 ⇒ 恒不出现） */}
                {invites.length > 0 && (
                  <p data-road-invite className="mt-3 border border-dashed border-line p-4 text-sm leading-relaxed text-ink-soft">
                    {dict.road.inviteLead}
                    <span className="mt-1 block text-ink">{invites.map((b) => bookTitle(b.id, locale)).join(' · ')}</span>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* 还没走到的地方：远处的风景，不是欠账——所以不计数、不排在前面、不催 */}
      {road && road.ahead.length > 0 && (
        <section className="mt-10 border-t border-line pt-6">
          <h2 className="text-xs tracking-widest text-ink-soft">{dict.road.aheadLabel}</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {road.ahead.map((topic) => (
              <li key={topic} data-road-ahead={topic} className="border border-dashed border-line px-3 py-1.5 text-sm text-ink-soft/70">
                {topicName(topic)}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-ink-soft/70">{dict.road.aheadHint}</p>
        </section>
      )}

      {/* 书露面的第三处：他打开过的书（出处清单） */}
      {road && road.books.length > 0 && (
        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-xs tracking-widest text-ink-soft">{dict.road.booksLabel}</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {road.books.map((b) => (
              <li key={b.bookId} data-road-book={b.bookId} className="text-sm leading-relaxed">
                {bookTitle(b.bookId, locale)}
                <span className="ml-2 text-xs text-ink-soft/60">{day(b.startedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link href={`/${locale}/journey`} className="mt-10 inline-block text-sm text-accent underline underline-offset-4">
        {dict.road.backToJourney}
      </Link>
    </div>
  );
}
