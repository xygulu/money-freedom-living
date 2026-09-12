'use client';

// 推进提议卡（M9 需求③）：本阶段灯全亮后出现——AI 提议，用户确认才推进。
// 「先留在这里」只是本地收起：不落库、无冷却惩罚，卡下次仍在但绝不打断。
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Dict } from '@/i18n/get-dict';

export default function AdvanceCard({
  locale,
  nextTitle,
  nextRitual,
  dict,
}: {
  locale: string;
  nextTitle: string;
  nextRitual: string;
  dict: Dict;
}) {
  const t = dict.journey;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [error, setError] = useState('');

  if (declined) return null;

  async function advance() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/journey/advance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      if (!res.ok) {
        setError(dict.me.error);
        return;
      }
      router.refresh(); // 新阶段的灯/心印由服务端渲染
    } catch {
      setError(dict.me.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 border border-accent/50 bg-white/70 p-6">
      <p className="text-sm leading-relaxed">{t.stageAllLit}</p>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">
        {t.stageNextInvite.replace('{stage}', nextTitle).replace('{ritual}', nextRitual)}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button
          type="button"
          disabled={busy}
          onClick={() => void advance()}
          className="border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-40"
        >
          {t.stageAdvanceCta}
        </button>
        <button
          type="button"
          onClick={() => setDeclined(true)}
          className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
        >
          {t.stageStay}
        </button>
      </div>
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </div>
  );
}
