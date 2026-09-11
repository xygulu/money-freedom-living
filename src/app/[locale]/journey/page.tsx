import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { getJourneyStages, pickDaily } from '@/lib/content';

// 今日一签的确定性抽取需要日期；SSG 下按构建日取签，运行时请求按当天
const todayISO = () => new Date().toISOString().slice(0, 10);

export default async function journeyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);
  const stages = getJourneyStages(locale);
  // M2：档案未接入（M3），一签先按阶段 1 取；seenTexts 由档案表接入后传入
  const daily = pickDaily(locale, todayISO(), 1);

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

      <h2 className="mt-14 text-sm tracking-widest text-ink-soft">{dict.journey.stages}</h2>
      <ol className="mt-4 flex flex-col">
        {stages.map((stage) => {
          const locked = stage.id === 4;
          return (
            <li key={stage.id} className="border-t border-line py-6">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-base font-medium">
                  {stage.id} · {stage.title}
                </h3>
                <span className="shrink-0 text-xs text-ink-soft">
                  {locked ? dict.journey.stageLocked : dict.journey.weeks.replace('{n}', String(stage.weeks))}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{stage.goal}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
