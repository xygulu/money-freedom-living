// /[locale]/portrait/compare：新旧画像并排（M9 需求②「画像会不同」的看见方式）。
// ?from=?to=（缺省：上一版 → 当前版）。五段逐段并置，桌面两列、移动端单列；
// 不引入 diff——「看看什么变了、什么还在。不评判，只是看见」。
import { headers, cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getDict } from '@/i18n/get-dict';
import { enabledLocales, isLocale } from '@/i18n/config';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import { listPortraitVersions, type PortraitVersion } from '@/lib/evolution';

export const dynamic = 'force-dynamic';

export default async function comparePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale) || !enabledLocales.includes(locale)) notFound();
  const dict = getDict(locale);
  const p = dict.portrait;

  const sp = await searchParams;
  const fromParam = typeof sp.from === 'string' ? Number(sp.from) : NaN;
  const toParam = typeof sp.to === 'string' ? Number(sp.to) : NaN;

  const identity = await resolveIdentity({ headers: await headers(), cookies: await cookies() });
  const profile = await getProfile(identity.key);
  const current = profile?.portrait;
  if (!current?.baseColor || !current.script) redirect(`/${locale}/portrait`);

  const versions = await listPortraitVersions(identity.key);
  const findRow = (n: number) => versions.find((v) => v.version === n) ?? null;

  // to：参数合法且存在才生效，缺省/无效回落当前版（当前版可能还没快照行，兜底组一行）
  const toRow: PortraitVersion | null = Number.isInteger(toParam) ? findRow(toParam) : null;
  const to: PortraitVersion =
    toRow ??
    findRow(current.version) ?? {
      version: current.version,
      source: 'onboarding',
      portrait: current,
      material: {},
      createdAt: current.createdAt ?? profile?.created_at ?? new Date().toISOString(),
    };

  // from：参数优先；缺省取版本表里 < to 的最大版本（「上一版」）；没有 → 无可对比
  const fromRow: PortraitVersion | null = Number.isInteger(fromParam)
    ? findRow(fromParam)
    : versions.filter((v) => v.version < to.version).sort((a, b) => b.version - a.version)[0] ?? null;

  const backLink = (
    <div className="mt-12 border-t border-line pt-6 pb-4">
      <Link href={`/${locale}/portrait`} className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink">
        ← {p.back}
      </Link>
    </div>
  );

  if (!fromRow) {
    return (
      <div className="flex flex-col pt-12">
        <h1 className="text-2xl font-medium tracking-tight">{p.compareTitle}</h1>
        <p className="mt-4 text-sm text-ink-soft">{p.compareEmpty}</p>
        {backLink}
      </div>
    );
  }

  // 五段两两并置；多行段（spoken/moments）用换行铺开
  const pairs = [
    { label: p.spokenTitle, past: fromRow.portrait.spoken.join('\n'), now: to.portrait.spoken.join('\n') },
    { label: p.baseColorTitle, past: fromRow.portrait.baseColor, now: to.portrait.baseColor },
    {
      label: p.momentsTitle,
      past: fromRow.portrait.moments.map((m) => `${m.title} — ${m.detail}`).join('\n'),
      now: to.portrait.moments.map((m) => `${m.title} — ${m.detail}`).join('\n'),
    },
    { label: p.scriptTitle, past: fromRow.portrait.script, now: to.portrait.script },
    { label: p.toFutureTitle, past: fromRow.portrait.toFuture, now: to.portrait.toFuture },
  ];
  const versionTag = (row: PortraitVersion) => p.versionItem.replace('{n}', String(row.version)).replace('{date}', row.createdAt.slice(0, 10));

  return (
    <div className="flex flex-col pt-12">
      <h1 className="text-2xl font-medium tracking-tight">{p.compareTitle}</h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{p.compareIntro}</p>

      {/* 桌面两列表头；移动端由各段内的列标签承接 */}
      <div className="mt-10 hidden gap-8 md:grid md:grid-cols-2">
        <p className="text-sm tracking-widest text-ink-soft">
          {p.compareColPast} · {versionTag(fromRow)}
        </p>
        <p className="text-sm tracking-widest text-accent">
          {p.compareColNow} · {versionTag(to)}
          {to.version === current.version ? ` · ${p.currentMark}` : ''}
        </p>
      </div>

      {pairs.map((sec) => (
        <section key={sec.label} className="mt-10">
          <h2 className="text-sm tracking-widest text-ink-soft">{sec.label}</h2>
          <div className="mt-3 grid gap-6 md:grid-cols-2 md:gap-8">
            <div>
              <p className="text-xs text-ink-soft/70 md:hidden">
                {p.compareColPast} · {versionTag(fromRow)}
              </p>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink-soft">{sec.past}</p>
            </div>
            <div className="border-l-2 border-accent/50 pl-4 md:border-l-0 md:pl-0">
              <p className="text-xs text-accent md:hidden">
                {p.compareColNow} · {versionTag(to)}
              </p>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{sec.now}</p>
            </div>
          </div>
        </section>
      ))}

      <p className="mt-10 text-sm leading-relaxed text-ink-soft">
        <Link href={`/${locale}/timeline`} className="text-accent underline underline-offset-4">
          {p.compareTrailLink}
        </Link>
      </p>

      {backLink}
    </div>
  );
}
