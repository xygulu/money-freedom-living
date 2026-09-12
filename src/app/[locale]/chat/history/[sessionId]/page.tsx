// /[locale]/chat/history/[sessionId]：单次对话只读回看（M9 需求①）。
// 归属校验（user_key 不符或不存在 → notFound，不泄露存在性）；
// 还开着的不算「那天的对话」→ 回 /chat。气泡观感与对话间一致，静态渲染无输入。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { resolveIdentity } from '@/lib/identity';
import { getSession, getSessionMessages } from '@/lib/chat';
import { formatTimelineDay } from '@/lib/timeline';

export const dynamic = 'force-dynamic';

export default async function chatReplayPage({
  params,
}: {
  params: Promise<{ locale: string; sessionId: string }>;
}) {
  const { locale, sessionId } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  const headersList = await headers();
  const cookieList = await cookies();
  const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });

  const session = await getSession(sessionId);
  if (!session || session.userKey !== identity.key) notFound();
  if (session.status !== 'closed') redirect(`/${locale}/chat`);

  const messages = await getSessionMessages(sessionId);
  const day = (session.closedAt ?? session.createdAt).slice(0, 10);

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.chat.historyReplayTitle}</h1>
      <p className="mt-3 text-sm text-ink-soft">
        {formatTimelineDay(locale, day)}
        <span className="ml-2 text-xs">
          {session.kind === 'onboarding_talk' ? dict.chat.historyOnboarding : dict.chat.historyTalk}
        </span>
      </p>
      <p className="mt-1 text-xs text-ink-soft/70">{dict.common.aiNotice}</p>

      <div className="mt-8 flex flex-col gap-4 rounded border border-line bg-white/50 p-5">
        {messages.map((turn, i) => (
          <div
            key={i}
            className={
              turn.role === 'user'
                ? 'self-end max-w-[85%] rounded bg-accent/10 px-4 py-2 text-sm'
                : 'self-start max-w-[85%] text-sm leading-relaxed'
            }
          >
            {turn.content.split('\n').map((line, j) => (
              <p key={j} className={j ? 'mt-1' : ''}>
                {line}
              </p>
            ))}
          </div>
        ))}
      </div>

      <div className="mt-8 flex gap-5 text-sm">
        <Link href={`/${locale}/chat/history`} className="text-accent underline underline-offset-4">
          {dict.chat.historyBack}
        </Link>
        <Link href={`/${locale}/chat`} className="text-accent underline underline-offset-4">
          {dict.chat.title} →
        </Link>
      </div>
    </div>
  );
}
