// /[locale]/chat/history：过往对话索引（M9 需求①「聊天也能看到历史记录」）。
// 只列 closed 会话，按「那天的那次对话」倒序；体检初谈也收录（金钱记忆内容珍贵，
// 打「体检初谈」标签）。只读；点进单次对话回看。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { resolveIdentity } from '@/lib/identity';
import { listClosedChatSessions } from '@/lib/chat';
import { formatTimelineDay } from '@/lib/timeline';

export const dynamic = 'force-dynamic';

export default async function chatHistoryPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  const headersList = await headers();
  const cookieList = await cookies();
  const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
  const sessions = await listClosedChatSessions(identity.key);

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.chat.historyTitle}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.chat.historySub}</p>
      <p className="mt-1 text-xs text-ink-soft/70">{dict.common.aiNotice}</p>

      {sessions.length === 0 ? (
        <div className="mt-8 border border-dashed border-line p-6">
          <p className="text-sm leading-relaxed text-ink-soft">{dict.chat.historyEmpty}</p>
          <Link
            href={`/${locale}/chat`}
            className="mt-5 inline-block border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper"
          >
            {dict.chat.start}
          </Link>
        </div>
      ) : (
        <ul className="mt-8 flex flex-col">
          {sessions.map((s) => {
            const day = (s.closedAt ?? s.createdAt).slice(0, 10);
            const firstTalk = s.kind === 'onboarding_talk';
            return (
              <li key={s.id} className="border-t border-line py-5 first:border-t-0">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 className="text-sm font-medium">
                    {formatTimelineDay(locale, day)}
                    <span className="ml-2 text-xs font-normal text-ink-soft">
                      {firstTalk ? dict.chat.historyOnboarding : dict.chat.historyTalk}
                    </span>
                  </h2>
                  <Link
                    href={`/${locale}/chat/history/${s.id}`}
                    className="shrink-0 text-accent underline underline-offset-4"
                  >
                    {dict.chat.historyView}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Link href={`/${locale}/chat`} className="mt-10 self-start text-sm text-accent underline underline-offset-4">
        {dict.chat.title} →
      </Link>
    </div>
  );
}
