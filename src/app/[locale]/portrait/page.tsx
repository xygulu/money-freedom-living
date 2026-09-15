// /[locale]/portrait：金钱画像（当前版可校准，历史版只读回看）。
// ?version=n：回看某一版快照（演进产物，M9 需求②）；无效/不存在/就是当前版
// 一律回落到当前版。五段渲染抽成页内局部组件，当前/历史两用（历史不挂校准入口）。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDict, type Dict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { resolveIdentity } from '@/lib/identity';
import { getProfile, type Portrait } from '@/lib/profile';
import { getPortraitVersion, listPortraitVersions } from '@/lib/evolution';
import { getUiVersion, withJourneyHref } from '@/lib/ui-version';
import PortraitCalibrate from '@/components/PortraitCalibrate';
import PortraitLockedCard from '@/components/PortraitLockedCard';

export const dynamic = 'force-dynamic';

/** 五段画像（你说过/底色/瞬间/脚本/给未来）。calibrate=false 时只读（历史版快照）。
 *  preview=true 时 ④⑤ 替换为 PortraitLockedCard（访客态）；校准入口/版本对比也隐藏。*/
function PortraitSections({
  portrait,
  dict,
  calibrate,
  preview,
  lockedHref,
}: {
  portrait: Portrait;
  dict: Dict;
  calibrate: boolean;
  preview: boolean;
  lockedHref: string;
}) {
  const p = dict.portrait;
  const latestScriptVerdict = [...portrait.calibrations].reverse().find((cal) => cal.section === 'script')?.verdict;

  return (
    <>
      {portrait.spoken.length > 0 && (
        <section className="mt-10" data-portrait-section="spoken">
          <h2 className="text-sm tracking-widest text-ink-soft">{p.spokenTitle}</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {portrait.spoken.map((line, i) => (
              <li key={i} className="border-l-2 border-accent/50 pl-3 text-sm leading-relaxed">
                「{line}」
                {calibrate && <PortraitCalibrate section={`spoken:${i}`} dict={dict} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {portrait.baseColor && (
        <section className="mt-10" data-portrait-section="baseColor">
          <h2 className="text-sm tracking-widest text-ink-soft">{p.baseColorTitle}</h2>
          <p className="mt-3 text-sm leading-relaxed">{portrait.baseColor}</p>
          {calibrate && <PortraitCalibrate section="baseColor" dict={dict} />}
        </section>
      )}

      {portrait.moments.length > 0 && (
        <section className="mt-10" data-portrait-section="moments">
          <h2 className="text-sm tracking-widest text-ink-soft">{p.momentsTitle}</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {portrait.moments.map((moment, i) => (
              <li key={i} className="text-sm leading-relaxed">
                <span className="font-medium">{moment.title}</span>
                <span className="text-ink-soft"> — {moment.detail}</span>
                {calibrate && <PortraitCalibrate section={`moment:${i}`} dict={dict} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview ? (
        <div className="mt-10">
          <PortraitLockedCard dict={dict} section="script" lockedHref={lockedHref} />
        </div>
      ) : (
        <section className="mt-10 border border-line bg-white/60 p-5" data-portrait-section="script">
          <h2 className="text-sm tracking-widest text-ink-soft">{p.scriptTitle}</h2>
          <p className="mt-3 text-sm leading-relaxed">{portrait.script}</p>
          {calibrate && portrait.scriptStatus === 'pending' && !latestScriptVerdict && (
            <PortraitCalibrate section="script" dict={dict} />
          )}
          {portrait.scriptStatus === 'confirmed' && <p className="mt-3 text-xs text-ink-soft">{p.scriptConfirmed}</p>}
          {portrait.scriptStatus === 'rejected' && <p className="mt-3 text-xs text-ink-soft">{p.scriptRejected}</p>}
        </section>
      )}

      {preview ? (
        <div className="mt-10">
          <PortraitLockedCard dict={dict} section="toFuture" lockedHref={lockedHref} />
        </div>
      ) : (
        portrait.toFuture && (
          <section className="mt-10" data-portrait-section="toFuture">
            <h2 className="text-sm tracking-widest text-ink-soft">{p.toFutureTitle}</h2>
            <p className="mt-3 text-sm leading-relaxed">{portrait.toFuture}</p>
            {calibrate && <PortraitCalibrate section="toFuture" dict={dict} />}
          </section>
        )
      )}
    </>
  );
}

export default async function portraitPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = withJourneyHref(getDict(locale), locale, await getUiVersion());
  const p = dict.portrait;

  const sp = await searchParams;
  const versionParam = typeof sp.version === 'string' ? Number(sp.version) : NaN;

  const identity = await resolveIdentity({ headers: await headers(), cookies: await cookies() });
  const isGuest = !identity.userId;
  const profile = await getProfile(identity.key);
  const current = profile?.portrait;
  const hasPortrait = Boolean(current?.baseColor && current.script);

  if (!hasPortrait || !current) {
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

  const versions = await listPortraitVersions(identity.key);
  // 回看历史版：参数合法且确实存在且不是当前版才生效；否则一律渲染当前版
  const requested =
    Number.isInteger(versionParam) && versionParam !== current.version ? await getPortraitVersion(identity.key, versionParam) : null;
  const shown = requested?.portrait ?? current;
  const historical = Boolean(requested);
  // 过往版本列表：多于 1 版才有「演进」可看
  const pastVersions = versions.filter((v) => v.version !== current.version).sort((a, b) => b.version - a.version);

  // preview = 访客模式：④⑤ 上锁 + 隐藏对比/校准入口 + 顶部引导条
  const preview = isGuest && !historical;
  const lockedHref = `/${locale}/login?next=${encodeURIComponent(`/${locale}/portrait`)}`;

  return (
    <div className="flex flex-col pt-12">
      <h1 className="text-2xl font-medium tracking-tight">{p.title}</h1>

      {preview && (
        <p
          data-guest-banner
          className="mt-4 text-sm leading-relaxed text-ink-soft"
        >
          {p.guestBanner}{' '}
          <Link href={lockedHref} className="text-accent underline underline-offset-4">
            {p.cta}
          </Link>
        </p>
      )}

      {historical && requested && (
        <div className="mt-6 border border-dashed border-line bg-white/60 p-5">
          <p className="text-sm leading-relaxed text-ink-soft">
            {p.historicalBanner.replace('{n}', String(requested.version)).replace('{date}', requested.createdAt.slice(0, 10))}
          </p>
          <Link href={`/${locale}/portrait`} className="mt-3 inline-block text-accent underline underline-offset-4">
            {p.backToCurrent}
          </Link>
        </div>
      )}

      {!historical && !preview && pastVersions.length > 0 && (
        <div className="mt-6">
          <Link href={`/${locale}/portrait/compare`} className="text-accent underline underline-offset-4">
            {p.compareLink}
          </Link>
        </div>
      )}

      <PortraitSections
        portrait={shown}
        dict={dict}
        calibrate={!historical && !preview}
        preview={preview}
        lockedHref={lockedHref}
      />

      {/* 一路走来的画像（多于 1 版才显）：演进过程可以随时回看——访客隐藏 */}
      {!preview && versions.length > 1 && (
        <section className="mt-12 border-t border-line pt-6">
          <p className="text-xs tracking-widest text-ink-soft">{p.versionsLabel}</p>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {pastVersions.map((v) => (
              <li key={v.version}>
                <Link
                  href={`/${locale}/portrait?version=${v.version}`}
                  className="text-ink-soft underline underline-offset-4 hover:text-ink"
                >
                  {p.versionItem.replace('{n}', String(v.version)).replace('{date}', v.createdAt.slice(0, 10))}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-12 border-t border-line pt-6 pb-4">
        <Link href={dict.nav.journeyHref} className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink">
          ← {p.back}
        </Link>
      </div>
    </div>
  );
}
