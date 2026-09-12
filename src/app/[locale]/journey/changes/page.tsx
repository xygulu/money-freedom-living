// /[locale]/journey/changes：《我变了什么》（M10，docs/03 §11）。
// 结构化部分服务端直出（位置变化/新点亮的心印+依据/下一步）——LLM 失败页面
// 仍有内容，叙述段只是叠加的一层；叙述段由 ChangeListGenerate 按需生成。
// 入口在 journey 页确认报告块尾部；无已确认评估 → 空态（入口本不出现）。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import { getJourneyStages } from '@/lib/content';
import { buildChangeListView } from '@/lib/changes';
import { track } from '@/lib/analytics';
import ChangeListGenerate from '@/components/ChangeListGenerate';

export const dynamic = 'force-dynamic';

export default async function changesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);

  const headersList = await headers();
  const cookieList = await cookies();
  const identity = await resolveIdentity({ headers: headersList, cookies: cookieList });
  const profile = await getProfile(identity.key);
  const view = profile ? buildChangeListView(profile) : null;

  // 埋点：看过清单即算回望发生（best-effort，绝不阻塞页面）
  if (view) {
    try {
      await track(identity.key, 'change_list_viewed', { narration: String(view.narration ? true : false) }, locale);
    } catch {
      // ignore
    }
  }

  const stages = getJourneyStages(locale);
  const stageTitle = (id: number) => stages.find((s) => s.id === id)?.title ?? String(id);

  return (
    <div className="flex flex-col pt-16">
      <h1 className="text-2xl font-medium tracking-tight">{dict.changes.title}</h1>

      {!view ? (
        <>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">{dict.changes.empty}</p>
          <Link href={`/${locale}/journey`} className="mt-6 inline-block text-sm text-accent underline underline-offset-4">
            {dict.changes.back}
          </Link>
        </>
      ) : (
        <>
          {/* 位置：上次 → 这次（首评无上次，只说这次） */}
          <p className="mt-6 text-sm leading-relaxed">
            <span className="text-xs tracking-widest text-ink-soft">{dict.changes.positionLabel}</span>
            <span className="mt-1.5 block text-base">
              {view.previousStage !== null ? (
                <>
                  {stageTitle(view.previousStage)} <span className="text-ink-soft">→</span> {stageTitle(view.currentStage)}
                </>
              ) : (
                stageTitle(view.currentStage)
              )}
            </span>
          </p>

          {/* 新点亮的心印 + 依据（他的原话）——数据直出，不依赖 LLM */}
          <div className="mt-8">
            <p className="text-xs tracking-widest text-ink-soft">{dict.changes.newLampsLabel}</p>
            {view.newLamps.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-2">
                {view.newLamps.map((l) => (
                  <li key={l.kind} className="text-sm leading-relaxed">
                    <span className="text-accent">● {(dict.stamps as unknown as Record<string, string>)[l.kind] ?? l.kind}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-ink-soft/80">
                      {dict.assess.evidenceLead}
                      {l.evidence}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-ink-soft">{dict.changes.noNewLamps}</p>
            )}
          </div>

          {/* 它想说的话：LLM 叙述段（缓存直出或按需生成） */}
          <div className="mt-8 border-l-2 border-accent/50 pl-4">
            <p className="text-xs tracking-widest text-ink-soft">{dict.changes.wordsLabel}</p>
            {view.narration ? (
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{view.narration.text}</p>
            ) : (
              <ChangeListGenerate locale={locale} dict={dict} />
            )}
          </div>

          {/* 下一步：沿用本次确认评估的行动建议 */}
          {view.actions.length > 0 && (
            <div className="mt-8">
              <p className="text-xs tracking-widest text-ink-soft">{dict.assess.actionsLabel}</p>
              <ul className="mt-2 flex flex-col gap-1">
                {view.actions.map((a, i) => (
                  <li key={i} className="text-sm leading-relaxed">
                    · {a}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Link href={`/${locale}/journey`} className="mt-10 inline-block text-sm text-accent underline underline-offset-4">
            {dict.changes.back}
          </Link>
        </>
      )}
    </div>
  );
}
