// /[locale]/privacy：隐私政策（docs/02 §9：国际版四语，附数据流图与删除时间线）。
// 文案本体在 src/lib/privacy.ts（政策文本与界面文案分离，整体审阅/换版本）。
import { notFound } from 'next/navigation';
import { enabledLocales, isLocale } from '@/i18n/config';
import { PRIVACY } from '@/lib/privacy';

export const dynamic = 'force-static';

export default async function privacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const text = PRIVACY[locale];

  return (
    <article className="mx-auto flex max-w-2xl flex-col pt-16 pb-16">
      <h1 className="text-2xl font-medium tracking-tight">{text.title}</h1>
      <p className="mt-2 text-xs text-ink-soft">{text.updated}</p>
      {text.intro.map((p) => (
        <p key={p.slice(0, 24)} className="mt-4 text-sm leading-relaxed">
          {p}
        </p>
      ))}
      {text.sections.map((section) => (
        <section key={section.title} className="mt-8 border-t border-line pt-6">
          <h2 className="text-base font-medium">{section.title}</h2>
          {section.paragraphs.map((p) => (
            <p key={p.slice(0, 24)} className="mt-3 text-sm leading-relaxed text-ink-soft">
              {p}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
