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
import { DEFAULT_BOOK_ID, pickDaily, pickExercise } from '@/lib/content';
import { requireSignedIn } from '@/lib/identity';
import { activeBookId, getProfile, recordDailySeen } from '@/lib/profile';
import { getUiVersion } from '@/lib/ui-version';
import { computeStageProgress } from '@/lib/stage';
import NewJourneyView from '@/components/NewJourneyView';

export const dynamic = 'force-dynamic';

const todayISO = () => new Date().toISOString().slice(0, 10);

export default async function journeyNewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
  // 必须在 uiVersion guard 之前——经典版访客也挡掉（避免 cookie 切换路径暴露内容）
  const identity = await requireSignedIn(locale, `/${locale}/journey-new`);

  // 经典版守卫（70-2 A2）。ui_version === 'classic' 时反向回到经典旅程页；
  // 经典版本身的 11 块内容保留在 /journey 一行不动。
  if ((await getUiVersion()) === 'classic') {
    redirect(`/${locale}/journey`);
  }

  const headersList = await headers();
  const cookieList = await cookies();
  const profile = await getProfile(identity.key);

  const stage = profile?.stage ?? 1;
  const today = todayISO();
  const bookId = profile ? activeBookId(profile) : DEFAULT_BOOK_ID;

  // 今日一签（去重档案里的 seenTexts）；与经典版共用同一池子
  const daily = pickDaily(
    locale,
    today,
    stage,
    (profile?.dailySeen ?? []).map((s) => s.text),
    bookId,
  );

  // 看过即记（幂等：同一天只记一条）
  if (daily && profile) {
    try {
      await recordDailySeen(identity.key, today, daily.text);
    } catch (error) {
      console.error('[journey-new] recordDailySeen failed:', error);
    }
  }

  // 今日微行动（按当前阶段练习确定性抽取）
  const exercise = pickExercise(locale, today, stage, identity.key, bookId);

  // 阶段进度（14 格里的"已走"格数；用于 PathBar 渲染）
  const progress = profile
    ? computeStageProgress(stage, profile, bookId)
    : { checks: [], litCount: 0 };

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

      <NewJourneyView
        locale={locale}
        dict={dict}
        daily={daily}
        exercise={exercise}
        progress={progress}
        userKey={identity.key}
        stage={stage}
      />
    </div>
  );
}
