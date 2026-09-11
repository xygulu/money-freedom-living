import Link from 'next/link';
import { visibleLocales } from '@/i18n/config';
import { getDict } from '@/i18n/get-dict';

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const dict = getDict(locale);

  return (
    <div className="flex flex-col pt-20">
      <h1 className="text-3xl leading-snug font-medium tracking-tight">{dict.landing.hero}</h1>

      <p className="mt-6 text-base leading-relaxed text-ink-soft">{dict.landing.sub}</p>

      <Link
        href={`/${locale}/onboarding`}
        className="mt-10 inline-block rounded-full bg-accent px-8 py-4 text-center text-base text-paper transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ink"
      >
        {dict.landing.cta}
      </Link>

      <p className="mt-4 text-sm text-ink-soft">{dict.landing.privacy}</p>

      <p className="mt-16 border-t border-line pt-6 text-xs leading-relaxed text-ink-soft">
        {dict.common.aiNotice}
      </p>

      <ul className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {visibleLocales.map(({ code, label, enabled }) => (
          <li key={code}>
            {code === locale ? (
              <span className="text-ink underline underline-offset-4">{label}</span>
            ) : enabled ? (
              <Link href={`/${code}`} className="text-ink-soft hover:text-ink hover:underline">
                {label}
              </Link>
            ) : (
              <span className="text-ink-soft/60">
                {label} · {dict.common.comingSoon}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
