// /[locale]/journey：旅程主页（docs/02 §5 每日节奏）。
// 今日三件事——全部可跳过，跳过不打断足迹，无未完成红点：
//   ① 今日一签（按当前阶段抽取；同一用户 90 天不重复，看过的记入档案 daily_seen）
//   ② 今日微行动（按当前阶段练习确定性抽取；"完成 + 一句感受"写入 experiments）
//   ③ 陪伴对话（进入 /chat，消耗会话配额）
// 阶段路标 + 当前位置 + 信件入口（阶段仪式：给现在的自己 / 写给钱的一封信）。
// 归来问候与发薪日锚点属 M7，这里不掺。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { getJourneyStages, pickDaily, pickExercise } from '@/lib/content';
import { resolveIdentity } from '@/lib/identity';
import { getProfile, recordDailySeen } from '@/lib/profile';
import MicroActionCard from '@/components/MicroActionCard';

export const dynamic = 'force-dynamic';

const todayISO = () => new Date().toISOString().slice(0, 10);

export default async function journeyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  const headersList = await headers();
  const cookieList = await cookies();
  const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
  const profile = await getProfile(identity.key);

  const stage = profile?.stage ?? 1;
  const today = todayISO();

  const daily = pickDaily(locale, today, stage, (profile?.dailySeen ?? []).map((s) => s.text));
  if (daily && profile) {
    // 看过的签记入档案（幂等：同一天只记一条）；无档案（未体检）不记——去重从有档案起算
    try {
      await recordDailySeen(identity.key, today, daily.text);
    } catch (error) {
      console.error('[journey] recordDailySeen failed:', error);
    }
  }

  const exercise = pickExercise(locale, today, stage, identity.key);
  const stages = getJourneyStages(locale);
  const letterCount = profile?.letters.length ?? 0;

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.journey.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.journey.sub}</p>

      {daily && (
        <section className="mt-10 border border-line bg-white/60 p-6">
          <p className="text-xs tracking-widest text-ink-soft">{dict.journey.dailyLabel}</p>
          <p className="mt-4 text-lg leading-relaxed">{daily.text}</p>
          <p className="mt-4 text-sm text-ink-soft">
            {dict.journey.dailyReflect}：{daily.reflection}
          </p>
        </section>
      )}

      <section className="mt-8 border border-line p-6">
        <p className="text-xs tracking-widest text-ink-soft">{dict.journey.microLabel}</p>
        {exercise ? (
          <>
            <p className="mt-4 text-base leading-relaxed">{exercise}</p>
            <MicroActionCard locale={locale} action={exercise} dict={dict} />
          </>
        ) : (
          <p className="mt-4 text-sm text-ink-soft">{dict.journey.microNone}</p>
        )}
        <div className="mt-5 flex flex-wrap gap-3 text-sm">
          <Link href={`/${locale}/chat`} className="text-accent underline underline-offset-4">
            {dict.journey.microChatAlt}
          </Link>
          <span aria-hidden className="text-line">·</span>
          <span className="text-ink-soft">{dict.journey.microDailyOnly}</span>
        </div>
      </section>

      <section className="mt-8 border border-line p-6">
        <p className="text-xs tracking-widest text-ink-soft">{dict.journey.chatLabel}</p>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">{dict.journey.chatHint}</p>
        <Link
          href={`/${locale}/chat`}
          className="mt-5 inline-block border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper"
        >
          {dict.journey.chatCta}
        </Link>
      </section>

      <section className="mt-8 border border-dashed border-line p-6">
        <p className="text-xs tracking-widest text-ink-soft">{dict.journey.letterLabel}</p>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">{dict.journey.letterHint}</p>
        <Link href={`/${locale}/letters`} className="mt-5 inline-block text-accent underline underline-offset-4">
          {dict.journey.letterCta}
          {letterCount > 0 ? `（${letterCount}）` : ''}
        </Link>
      </section>

      <h2 className="mt-14 text-sm tracking-widest text-ink-soft">{dict.journey.stages}</h2>
      <ol className="mt-4 flex flex-col">
        {stages.map((s) => {
          const locked = s.id === 4;
          const current = s.id === stage;
          return (
            <li key={s.id} className="border-t border-line py-6">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className={`text-base font-medium ${current ? '' : 'text-ink-soft'}`}>
                  {s.id} · {s.title}
                </h3>
                <span className="shrink-0 text-xs text-ink-soft">
                  {locked
                    ? dict.common.comingSoon
                    : current
                      ? dict.journey.currentStage
                      : dict.journey.weeks.replace('{n}', String(s.weeks))}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{s.goal}</p>
              {current && (
                <p className="mt-2 text-xs text-accent">● {dict.journey.currentStageNote}</p>
              )}
            </li>
          );
        })}
      </ol>

      {/* 付费墙触发点③（soft gate）：阶段毕业想看深度报告时。MVP 中报告功能未上线，占位引导 */}
      <p className="mt-8 border-t border-line pt-6 text-xs leading-relaxed text-ink-soft/70">
        {dict.journey.reportTeaser}{' '}
        <Link href={`/${locale}/vip`} className="text-accent underline underline-offset-4">
          {dict.vip.vipLink}
        </Link>
      </p>
    </div>
  );
}
