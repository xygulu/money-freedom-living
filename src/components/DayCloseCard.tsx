'use client';

// 「合」的一格提交（docs/10 P0-1）：三行压成一屏，一个按钮收尾。
//
// 为什么不是三张卡、不是跳去对话：三张并排的卡＝三个未完成项＝天然欠账感；跳去对话
// 则等于把"今天到这里"变成"再去聊一轮"——一段路只有一个出口，走到尾就是走完了。
//
// 硬规则（每一条都对应一行代码）：
// - ①必选，②③可留空、可点「想不起来」——**可跳过是硬要求**，否则第③问会变成负担，
//   反而压垮自发继续率。
// - 提交后先给一句回应（用他自己的话回，不评价不给结论），再出现「今天到这里」。
// - **不出现**进度条、连续天数、红色提醒、未读点。这里一个数字都没有。
// - AI 认出"这句话和以前不一样"时只**提议**记一笔，记不记他说了算，记完还能真删。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';

type Did = 'done' | 'partial' | 'missed';

export default function DayCloseCard({
  locale,
  dict,
  node,
}: {
  locale: string;
  dict: Dict;
  /** 从节点信里回来的（?from=touch&node=D7）——这一格同时是那个节点的答卷 */
  node?: string;
}) {
  const t = dict.journey;
  const [did, setDid] = useState<Did | null>(null);
  const [thought, setThought] = useState('');
  const [firstLine, setFirstLine] = useState('');
  const [cantRecall, setCantRecall] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [receipt, setReceipt] = useState<string | null>(null);
  const [showSafety, setShowSafety] = useState(false);
  const [migration, setMigration] = useState<{ topic: string; quote: string } | null>(null);
  const [keptAt, setKeptAt] = useState<string | null>(null);

  const options: { value: Did; label: string }[] = [
    { value: 'done', label: t.closeDidDone },
    { value: 'partial', label: t.closeDidPartial },
    { value: 'missed', label: t.closeDidMissed },
  ];

  async function submit() {
    if (!did || state !== 'idle') return;
    setState('saving');
    try {
      const res = await fetch('/api/journey/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          did,
          thought: thought.trim() || undefined,
          firstLine: cantRecall ? undefined : firstLine.trim() || undefined,
          firstLineSkipped: cantRecall,
          node,
          locale,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        receipt?: string | null;
        safety?: boolean;
        migration?: { topic: string; quote: string } | null;
      };
      setReceipt(typeof data.receipt === 'string' && data.receipt ? data.receipt : null);
      setShowSafety(data.safety === true);
      setMigration(data.migration ?? null);
      setState('saved');
    } catch {
      setState('idle'); // 失败保留他填的字，回到可提交状态
      window.alert(dict.onboarding.error);
    }
  }

  async function keepMigration() {
    if (!migration) return;
    try {
      const res = await fetch('/api/journey/close/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...migration, locale }),
      });
      const data = (await res.json()) as { at?: string };
      setKeptAt(typeof data.at === 'string' ? data.at : null);
    } catch {
      /* 记不上就当没提议过——这一笔不值得打断他的收尾 */
      setMigration(null);
    }
  }

  async function undoMigration() {
    if (!migration || !keptAt) return;
    const q = new URLSearchParams({ topic: migration.topic, at: keptAt, locale });
    await fetch(`/api/journey/close/migrate?${q}`, { method: 'DELETE' }).catch(() => null);
    setMigration(null);
    setKeptAt(null);
  }

  if (state === 'saved') {
    return (
      <div data-close-state="saved" className="mt-5">
        {receipt && <p className="text-sm leading-relaxed">{receipt}</p>}
        {showSafety && <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.chat.safetyNote}</p>}

        {migration && (
          <div data-close-migration className="mt-5 border border-dashed border-line p-4">
            {keptAt === null ? (
              <>
                <p className="text-sm leading-relaxed text-ink-soft">{t.closeMigrateLead}</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    onClick={keepMigration}
                    className="border border-ink px-4 py-2 text-sm transition-colors hover:bg-ink hover:text-paper"
                  >
                    {t.closeMigrateKeep}
                  </button>
                  <button onClick={() => setMigration(null)} className="px-2 py-2 text-sm text-ink-soft underline underline-offset-4">
                    {t.closeMigrateNo}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm leading-relaxed text-ink-soft">
                {t.closeMigrateKept}
                <button onClick={undoMigration} className="ml-3 text-sm underline underline-offset-4">
                  {t.closeMigrateUndo}
                </button>
              </p>
            )}
          </div>
        )}

        {/* 明确收束：一段路走到这儿就合上了，不留「明天还有」的尾巴 */}
        <div data-day-close className="mt-6 border-t border-dashed border-line pt-5">
          <p className="text-sm leading-relaxed">{t.arcCloseTitle}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-soft/70">{t.arcCloseNote}</p>
        </div>
      </div>
    );
  }

  return (
    <div data-close-form className="mt-5">
      <fieldset>
        <legend className="text-sm text-ink-soft">{t.closeQ1}</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={did === o.value}
              onClick={() => setDid(o.value)}
              className={`border px-4 py-2 text-sm transition-colors ${
                did === o.value ? 'border-ink bg-ink text-paper' : 'border-line hover:border-ink'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="mt-6 block text-sm text-ink-soft" htmlFor="close-thought">
        {t.closeQ2}
      </label>
      <input
        id="close-thought"
        value={thought}
        onChange={(e) => setThought(e.target.value)}
        placeholder={t.closeOptional}
        maxLength={300}
        className="mt-2 w-full border border-line bg-white/60 p-3 text-sm leading-relaxed outline-none focus:border-ink"
      />

      <label className="mt-5 block text-sm text-ink-soft" htmlFor="close-first-line">
        {t.closeQ3}
      </label>
      <input
        id="close-first-line"
        value={firstLine}
        disabled={cantRecall}
        onChange={(e) => setFirstLine(e.target.value)}
        placeholder={t.closeOptional}
        maxLength={300}
        className="mt-2 w-full border border-line bg-white/60 p-3 text-sm leading-relaxed outline-none focus:border-ink disabled:opacity-50"
      />
      <button
        type="button"
        aria-pressed={cantRecall}
        onClick={() => {
          setCantRecall((v) => !v);
          setFirstLine('');
        }}
        className={`mt-2 text-xs underline underline-offset-4 ${cantRecall ? 'text-ink' : 'text-ink-soft'}`}
      >
        {t.closeCantRecall}
      </button>

      <div className="mt-6">
        <button
          onClick={submit}
          disabled={!did || state === 'saving'}
          className="border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-40"
        >
          {state === 'saving' ? '…' : t.closeSubmit}
        </button>
      </div>
    </div>
  );
}
