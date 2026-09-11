import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import PortraitCalibrate from '@/components/PortraitCalibrate';

export const dynamic = 'force-dynamic';

export default async function portraitPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);
  const p = dict.portrait;

  const identity = await resolveIdentity({ headers: await headers(), cookies: await cookies() });
  const profile = await getProfile(identity.key);
  const portrait = profile?.portrait;
  const hasPortrait = Boolean(portrait?.baseColor && portrait.script);

  if (!hasPortrait || !portrait) {
    return (
      <div className="flex flex-col items-center pt-20 text-center">
        <h1 className="text-2xl font-medium tracking-tight">{p.title}</h1>
        <p className="mt-4 text-sm text-ink-soft">{p.empty}</p>
        <Link href={`/${locale}/onboarding`} className="mt-8 rounded-full bg-accent px-8 py-3 text-base text-paper hover:opacity-90">
          {p.cta}
        </Link>
      </div>
    );
  }

  const latestScriptVerdict = [...portrait.calibrations].reverse().find((cal) => cal.section === 'script')?.verdict;

  return (
    <div className="flex flex-col pt-12">
      <h1 className="text-2xl font-medium tracking-tight">{p.title}</h1>

      {portrait.spoken.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm tracking-widest text-ink-soft">{p.spokenTitle}</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {portrait.spoken.map((line, i) => (
              <li key={i} className="border-l-2 border-accent/50 pl-3 text-sm leading-relaxed">
                「{line}」
                <PortraitCalibrate section={`spoken:${i}`} dict={dict} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {portrait.baseColor && (
        <section className="mt-10">
          <h2 className="text-sm tracking-widest text-ink-soft">{p.baseColorTitle}</h2>
          <p className="mt-3 text-sm leading-relaxed">{portrait.baseColor}</p>
          <PortraitCalibrate section="baseColor" dict={dict} />
        </section>
      )}

      {portrait.moments.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm tracking-widest text-ink-soft">{p.momentsTitle}</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {portrait.moments.map((moment, i) => (
              <li key={i} className="text-sm leading-relaxed">
                <span className="font-medium">{moment.title}</span>
                <span className="text-ink-soft"> — {moment.detail}</span>
                <PortraitCalibrate section={`moment:${i}`} dict={dict} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10 border border-line bg-white/60 p-5">
        <h2 className="text-sm tracking-widest text-ink-soft">{p.scriptTitle}</h2>
        <p className="mt-3 text-sm leading-relaxed">{portrait.script}</p>
        {portrait.scriptStatus === 'pending' && !latestScriptVerdict && <PortraitCalibrate section="script" dict={dict} />}
        {portrait.scriptStatus === 'confirmed' && <p className="mt-3 text-xs text-ink-soft">{p.scriptConfirmed}</p>}
        {portrait.scriptStatus === 'rejected' && <p className="mt-3 text-xs text-ink-soft">{p.scriptRejected}</p>}
      </section>

      {portrait.toFuture && (
        <section className="mt-10">
          <h2 className="text-sm tracking-widest text-ink-soft">{p.toFutureTitle}</h2>
          <p className="mt-3 text-sm leading-relaxed">{portrait.toFuture}</p>
          <PortraitCalibrate section="toFuture" dict={dict} />
        </section>
      )}

      <div className="mt-12 border-t border-line pt-6 pb-4">
        <Link href={`/${locale}/journey`} className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink">
          ← {p.back}
        </Link>
      </div>
    </div>
  );
}
