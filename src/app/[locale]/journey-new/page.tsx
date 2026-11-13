// /[locale]/journey-new：一幕 · 一人 · 一存档（70-2 主页面）。
//
// 经典版守卫：ui_version === 'classic' 时重定向到 /journey（一行不动）。
// 否则：服务端取档案 + 今日一签 + 今日微行动 + 当前阶段进度 → 交给 NewJourneyView。
//
// 五个段（按从上到下顺序）：
//   [topbar] 日期 + SVG 存档图标按钮（C 项：原型 line 222-228，不是文字链接） → /archive
//   [daily] 今日一签（pickDaily）+ reflection
//   [act]   今天这一步（pickExercise + 三选一：做了/换一个/跳过 → commitSheet 弹层）
//   [mirror] 提交后：用户原话 + 陪伴者一句 echo + 「想多说两句」门（MirrorCard）
//   [path]  14 格 + 4 阶段节点（PathBar）
//
// 经典版归经典版（/journey）——本页与它不共享组件（除 pickDaily/pickExercise 这种
// 纯函数），迁移动作不在本批。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { DEFAULT_BOOK_ID, bookTitle, formatBookTitles, getBooks, getJourneyStages, pickDaily, pickExercise } from '@/lib/content';
import { requireSignedIn } from '@/lib/identity';
import { activeBookEntries, activeBookId, getProfile, recordDailySeen } from '@/lib/profile';
import { getUiVersion } from '@/lib/ui-version';
import { computeStageProgress } from '@/lib/stage';
import { getSttProviders } from '@/lib/stt';
import { lastQuoteBefore } from '@/lib/road';
import { isVerdictNode } from '@/lib/cognition';
import { nodeQuestion, returnGapBucket, touchReturnQuery } from '@/lib/touch';
import { track } from '@/lib/analytics';
import NewJourneyView from '@/components/NewJourneyView';
import AddBookEntry from '@/components/AddBookEntry';

export const dynamic = 'force-dynamic';

const todayISO = () => new Date().toISOString().slice(0, 10);

export default async function journeyNewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string; node?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
  // 必须在 uiVersion guard 之前——经典版访客也挡掉（避免 cookie 切换路径暴露内容）
  const identity = await requireSignedIn(locale, `/${locale}/journey-new`);

  // 触达归因参数（A1/U1 修复，2026-09-24）：白名单校验收在 touchReturnQuery 一处。
  // 跨版本守卫 redirect 时 query 原样带走（此前 redirect 丢 query——classic 用户点信里
  // 的链接回来，归因参数会在跳转中丢失，touch_return 永远记不上）。
  const query = await searchParams;
  const returnQuery = touchReturnQuery(query);
  const returnSuffix = returnQuery ? `?${returnQuery}` : '';

  // 经典版守卫（70-2 A2）。ui_version === 'classic' 时反向回到经典旅程页；
  // 经典版本身的 11 块内容保留在 /journey 一行不动。
  if ((await getUiVersion()) === 'classic') {
    redirect(`/${locale}/journey${returnSuffix}`);
  }

  const headersList = await headers();
  const cookieList = await cookies();
  const profile = await getProfile(identity.key);

  const stage = profile?.stage ?? 1;
  const today = todayISO();
  // 主线书（汇入制下 = 最早开始的 active）：阶段进度、段名跟它——行级 stage 真源只覆盖主线
  const bookId = profile ? activeBookId(profile) : DEFAULT_BOOK_ID;

  // 今日一签（去重档案里的 seenTexts）。汇入制：所有 active 书的池子合并（主线在前，
  // 跨书按文本去重）；各书自己的焦点命题落在各自的池片上（V0.2 B5 忠于书级焦点）
  const activeEntries = profile ? activeBookEntries(profile) : [];
  const dailyRefs = activeEntries.map((b) => ({ bookId: b.bookId, focusTopic: b.focusTopic ?? null }));
  const daily = pickDaily(
    locale,
    today,
    stage,
    (profile?.dailySeen ?? []).map((s) => s.text),
    dailyRefs.length > 0 ? dailyRefs : [{ bookId: DEFAULT_BOOK_ID }],
  );

  // 看过即记（幂等：同一天只记一条）
  if (daily && profile) {
    try {
      await recordDailySeen(identity.key, today, daily.text);
    } catch (error) {
      console.error('[journey-new] recordDailySeen failed:', error);
    }
  }

  // 今日微行动（按当前阶段练习确定性抽取；union 所有 active 书，主线在前）
  const exercise = pickExercise(
    locale,
    today,
    stage,
    identity.key,
    activeEntries.length > 0 ? activeEntries.map((b) => b.bookId) : [DEFAULT_BOOK_ID],
  );

  // 阶段进度（14 格里的"已走"格数；用于 PathBar 渲染）
  const progress = profile
    ? computeStageProgress(locale, stage, profile, bookId)
    : { checks: [], litCount: 0 };

  // 「你上次留在这里」（P3-4，docs/06 §2.2 昨日回响）：今天之前最近一句他自己的话。
  // 没有就不渲染（留白不占位）；今天的原话不算"上次"（MirrorCard 已经照过一次）。
  const lastEcho = profile ? lastQuoteBefore(profile, today) : null;

  // 验收打点（与 classic /journey 同口径；A1/U1：此前新版完全不记——邮件拉回的
  // 归因在新版不可测，"触达拉回率"护栏指标只能拿到 classic 一半的数据）。
  const gapBucket = returnGapBucket(profile?.last_active_date, today);
  try {
    await track(identity.key, 'journey_visit', { gap: gapBucket }, locale);
    // 从信里回来的那一次单独记一笔。用 returnQuery 当闸（from=touch + node=D<数字>
    // 的白名单校验已收在 touchReturnQuery 一处）——D3 也算：它不提问不判定，
    // 但"被信叫回来了"这件事必须记，否则 D3 这封的拉回效果永远测不到。
    if (returnQuery) {
      await track(identity.key, 'touch_return', { node: query.node!, gap: gapBucket }, locale);
    }
  } catch {
    // 打点绝不阻塞页面
  }

  // 节点问题（docs/10 §2.2）：只有 6 个判定节点有——D3 是"你上次说的那句话我留着"，不提问。
  const nodeParam = isVerdictNode(query?.node) ? query.node : undefined;
  const nodeQuestionText = nodeParam ? nodeQuestion(dict, nodeParam) : null;
  // close 提交要带的归因字段：让 node_verdict 能认出"这格答卷是从信里回来的"
  // （判据与上面 touch_return 同一处白名单，两处口径不可能再分叉）。
  const fromTouch = returnQuery ? 'touch' : undefined;

  // 阶段名属于书（U6：i18n 里不得留单本书的阶段语汇）——从内容层按当前书取，
  // 路上的节点名随书替换（title 就是各语言 journey md 里的短名，如「看见」）
  const stageNames = getJourneyStages(locale, bookId).map((s) => s.title);

  // 加书候选（汇入制）：catalog 里已上线（status==='active'）且档案里还没有的书。
  // draft 不列（红线 1：不陈列还没上线的书）；全部已加则整个入口不渲染。
  const candidates = getBooks().filter(
    (b) => b.status === 'active' && !activeEntries.some((e) => e.bookId === b.id),
  );

  return (
    <div className="flex flex-col pt-12" data-step="root">
      {/* 顶部：日期 + SVG 存档图标按钮（C 项：原型 line 222-228） */}
      <header className="mb-8 flex items-baseline justify-between">
        <time
          className="text-xs uppercase tracking-[0.18em] text-ink-soft"
          suppressHydrationWarning
        >
          {new Date().toLocaleDateString(locale, { month: '2-digit', day: '2-digit' })}
        </time>
        <Link
          href={`/${locale}/archive`}
          aria-label={dict.archivePage.title}
          data-archive-link=""
          className="text-ink-soft transition-colors hover:text-ink"
        >
          {/* 存档图标按钮（24×20 viewBox；原型 §A1） */}
          <svg
            viewBox="0 0 24 20"
            width="24"
            height="20"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3.5" width="14" height="13" rx="2" />
            <path d="M3 8h14M8 8v8.5" />
          </svg>
        </Link>
      </header>

      {/* 你上次留在这里（P3-4）：最便宜的"被记住"体感——没有引语整个不渲染 */}
      {lastEcho && (
        <div data-last-echo className="mb-8 border border-line bg-white/60 p-5">
          <p className="text-xs tracking-widest text-ink-soft">{dict.journey.lastEchoLead}</p>
          <p className="mt-2 text-sm leading-relaxed">{lastEcho.text}</p>
        </div>
      )}

      <NewJourneyView
        locale={locale}
        dict={dict}
        daily={daily}
        exercise={exercise}
        progress={progress}
        stageNames={stageNames}
        userKey={identity.key}
        stage={stage}
        speechEnabled={getSttProviders().length > 0}
        nodeQuestion={nodeQuestionText}
        closeNode={nodeParam}
        closeFrom={fromTouch}
      />

      {/* 归属行（2026-09-24 用户拍板「用户需要知道在落地的是哪几本书」）：汇入制下
          一签/练习来自全部 active 书的合并池，这行低调告知「你的成长里有哪几本的内容」。
          红线 8 不破：只归属、无进度、无管理动作，书仍不以「物」的身份露面。
          activeEntries 主线在前（activeBookEntries 排序）；候选空/全部已加时这行仍在。 */}
      {activeEntries.length > 0 && (
        <p data-book-attribution="" className="mt-8 text-sm text-ink-soft">
          {dict.addBook.attributionLead}
          {formatBookTitles(
            activeEntries.map((e) => bookTitle(e.bookId, locale)),
            locale,
          )}
          {dict.addBook.attributionTrail}
        </p>
      )}

      {/* 加书入口（汇入制）：只列已上线且还没加的书，没有候选整个不渲染（红线 1：不陈列）。
          书在这里只以「内容会落进哪些场景」的身份露面，不做书架、无进度无红点（红线 8）。 */}
      {candidates.length > 0 && (
        <AddBookEntry
          locale={locale}
          dict={dict}
          books={candidates.map((b) => ({ id: b.id, title: bookTitle(b.id, locale), topics: b.topics }))}
        />
      )}
    </div>
  );
}
