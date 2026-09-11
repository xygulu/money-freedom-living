'use client';

// 画像校准小件：每段旁「说中了 / 不太像」；不太像可写一句修正。
// 写回后 router.refresh() 让服务端重渲染最新画像。
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Dict } from '@/i18n/get-dict';

interface Props {
  section: string;
  dict: Dict;
}

export default function PortraitCalibrate({ section, dict }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [correction, setCorrection] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const c = dict.onboarding.calibrate;

  async function submit(verdict: 'hit' | 'miss') {
    setBusy(true);
    try {
      const response = await fetch('/api/onboarding/calibrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, verdict, correction: correction.trim() || undefined }),
      });
      if (response.ok) {
        setSaved(true);
        setOpen(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  if (saved) return <p className="text-xs text-ink-soft">{c.saved}</p>;

  if (open) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <input
          value={correction}
          onChange={(e) => setCorrection(e.target.value)}
          placeholder={c.correction}
          maxLength={300}
          className="w-full rounded border border-line bg-white/60 p-2 text-sm outline-none focus:border-accent"
        />
        <div className="flex gap-2">
          <button type="button" disabled={busy || !correction.trim()} onClick={() => submit('miss')} className="rounded-full border border-accent px-4 py-1.5 text-xs text-accent hover:bg-accent hover:text-paper disabled:opacity-40">
            {dict.onboarding.reflect.send}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="px-2 text-xs text-ink-soft hover:text-ink">
            ×
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 flex gap-3 text-xs">
      <button type="button" disabled={busy} onClick={() => submit('hit')} className="text-ink-soft underline underline-offset-4 hover:text-ink disabled:opacity-40">
        {c.hit}
      </button>
      <button type="button" disabled={busy} onClick={() => setOpen(true)} className="text-ink-soft underline underline-offset-4 hover:text-ink disabled:opacity-40">
        {c.miss}
      </button>
    </div>
  );
}
