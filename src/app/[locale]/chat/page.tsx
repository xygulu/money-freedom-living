// /[locale]/chat：陪伴对话（M4）。
// 服务端取身份/档案/打开中的会话/配额状态 → 无会话时展示开始卡片
// （配额用完即付费墙触发点①文案），有会话时直接进入对话间。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { resolveIdentity } from '@/lib/identity';
import { findOpenChatSession, getSessionMessages } from '@/lib/chat';
import { getQuotaStatus, clientIpFromHeaders, guestKeyForRequest, GUEST_ID_COOKIE, todayUtc } from '@/lib/quota';
import ChatView from '@/components/ChatView';

export const dynamic = 'force-dynamic';

export default async function chatPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ start?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);
  // ?start=1 = 从旅程页「随便聊聊 / 开始今天的对话」点进来的：已经表达过要聊了，
  // 不再要求第二次点击，落地即建会话（建会话不扣配额，落账仍在首条 AI 回复）。
  const autoStart = (await searchParams).start === '1';

  const headersList = await headers();
  const cookieList = await cookies();
  const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });

  const open = await findOpenChatSession(identity.key);
  const messages = open ? await getSessionMessages(open.id) : [];

  const guest = guestKeyForRequest(
    cookieList.get(GUEST_ID_COOKIE)?.value,
    clientIpFromHeaders(headersList),
    todayUtc()
  );
  const quota = await getQuotaStatus({ userId: identity.userId, guestKey: guest.guestKey });

  return (
    <div className="flex flex-col pt-12">
      <h1 className="text-2xl font-medium tracking-tight">{dict.chat.title}</h1>
      <p className="mt-2 text-sm text-ink-soft">{dict.chat.subtitle}</p>
      <p className="mt-1 text-xs text-ink-soft/70">{dict.common.aiNotice}</p>
      <div className="mt-8">
        <ChatView
          locale={locale}
          dict={dict}
          openSessionId={open?.id ?? null}
          initialMessages={messages}
          remaining={quota.remaining}
          autoStart={autoStart}
        />
      </div>
      <Link href={`/${locale}/chat/history`} className="mt-8 self-start text-sm text-accent underline underline-offset-4">
        {dict.chat.historyLink} →
      </Link>
    </div>
  );
}
