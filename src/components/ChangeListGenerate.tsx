'use client';

// 《我变了什么》叙述段生成按钮（M10）：LLM 生成失败时页面结构化部分仍在，
// 按钮可重试——失败不阻断回望。
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Dict } from '@/i18n/get-dict';

export default function ChangeListGenerate({ locale, dict }: { locale: string; dict: Dict }) {
  const t = dict.changes;
  const [state, setState] = useState<'idle' | 'busy'>('idle');
  const [failed, setFailed] = useState(false);
  const router = useRouter();

  async function generate() {
    if (state === 'busy') return;
    setState('busy');
    setFailed(false);
    try {
      const res = await fetch('/api/journey/changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      setFailed(true);
      setState('idle');
    }
  }

  return (
    <div className="mt-4">
      <button
        onClick={generate}
        disabled={state === 'busy'}
        className="border border-ink px-4 py-2 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
      >
        {state === 'busy' ? t.busy : t.generate}
      </button>
      {failed && <p className="mt-2 text-sm text-ink-soft">{t.failed}</p>}
    </div>
  );
}
