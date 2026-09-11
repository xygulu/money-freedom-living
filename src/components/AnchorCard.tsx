'use client';

// 周期情绪锚点设置（docs/02 §5）：发薪日因国家/公司而异——默认不猜，
// 用户自设（每月某日 / 双周某天 / 每周某天 / 不设置）。文案本地化，不直译"发薪日"。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';
import type { Payday } from '@/lib/anchor';

interface Props {
  locale: string;
  payday: Payday | null;
  dict: Dict;
}

export default function AnchorCard({ locale, payday, dict }: Props) {
  const t = dict.journey;
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<Payday['type']>(payday?.type ?? 'monthly');
  const [day, setDay] = useState<number>(payday?.day ?? 1);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const days = type === 'monthly'
    ? Array.from({ length: 28 }, (_, i) => i + 1)
    : [1, 2, 3, 4, 5, 6, 0]; // 周一到周日（0 = 周日放最后，符合阅读习惯）

  async function save(next: Payday | null) {
    setBusy(true);
    setSaved(false);
    try {
      const response = await fetch('/api/journey/anchor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payday: next }),
      });
      if (response.ok) {
        setSaved(true);
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  }

  const WEEKDAY_NAMES = locale === 'ja'
    ? ['日', '月', '火', '水', '木', '金', '土']
    : locale === 'zh-CN'
      ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
      : locale === 'zh-TW'
        ? ['週日', '週一', '週二', '週三', '週四', '週五', '週六']
        : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function describe(p: Payday): string {
    if (p.type === 'monthly') return t.anchorMonthly.replace('{day}', String(p.day ?? 1));
    const weekday = WEEKDAY_NAMES[p.day ?? 1];
    return p.type === 'weekly' ? t.anchorWeekly.replace('{day}', weekday) : t.anchorBiweekly.replace('{day}', weekday);
  }

  return (
    <section className="mt-6 border border-line p-6">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-xs tracking-widest text-ink-soft">{t.anchorLabel}</p>
        {payday && (
          <button type="button" onClick={() => save(null)} disabled={busy} className="text-xs text-ink-soft underline underline-offset-4 disabled:opacity-40">
            {t.anchorClear}
          </button>
        )}
      </div>

      {!open ? (
        <div className="mt-3">
          <p className="text-sm leading-relaxed text-ink-soft">
            {payday ? describe(payday) : t.anchorHint}{' '}
            <button type="button" onClick={() => setOpen(true)} className="text-accent underline underline-offset-4">
              {payday ? t.anchorChange : t.anchorSet}
            </button>
          </p>
          {saved && <p className="mt-2 text-xs text-accent">{t.anchorSaved}</p>}
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap gap-4">
            {(['monthly', 'biweekly', 'weekly'] as const).map((opt) => (
              <label key={opt} className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="anchor-type"
                  checked={type === opt}
                  onChange={() => {
                    setType(opt);
                    setDay(opt === 'monthly' ? 1 : day === 1 ? 1 : day);
                  }}
                />
                {opt === 'monthly' ? t.anchorTypeMonthly : opt === 'biweekly' ? t.anchorTypeBiweekly : t.anchorTypeWeekly}
              </label>
            ))}
          </div>
          {type === 'monthly' ? (
            <label className="flex items-center gap-2">
              {t.anchorDayOfMonth}
              <select
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                className="rounded border border-line bg-white px-2 py-1"
              >
                {days.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex items-center gap-2">
              {t.anchorDayOfWeek}
              <select
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
                className="rounded border border-line bg-white px-2 py-1"
              >
                {days.map((d) => (
                  <option key={d} value={d}>{WEEKDAY_NAMES[d]}</option>
                ))}
              </select>
            </label>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => save({ type, day })}
              className="rounded-full bg-accent px-5 py-1.5 text-sm text-paper hover:opacity-90 disabled:opacity-40"
            >
              {t.anchorSave}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-ink-soft underline underline-offset-4">
              {t.anchorCancel}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
