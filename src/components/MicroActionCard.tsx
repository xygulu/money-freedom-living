'use client';

// 今日微行动卡（docs/02 阶段 3 实验记录入口）：
// "完成实验 + 一句话感受"直接写入 experiments[]；感受可空（记没做/做砸都算数）。
// 命中危机词时照常写入（用户的话就是用户的话），展示转介提示。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';

export default function MicroActionCard({
  locale,
  action,
  dict,
}: {
  locale: string;
  action: string;
  dict: Dict;
}) {
  const t = dict.journey;
  const [feeling, setFeeling] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [showSafety, setShowSafety] = useState(false);

  async function submit() {
    if (state !== 'idle') return;
    setState('saving');
    try {
      const res = await fetch('/api/journey/experiment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, feeling: feeling.trim() || undefined, locale }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { safety?: boolean };
      setShowSafety(data.safety === true);
      setState('saved');
    } catch {
      // 失败保留输入，回到可提交状态
      setState('idle');
      window.alert(dict.onboarding.error);
    }
  }

  if (state === 'saved') {
    return (
      <div className="mt-5">
        <p className="text-sm text-ink-soft">{t.microSaved}</p>
        {showSafety && <p className="mt-3 text-sm leading-relaxed text-ink-soft">{dict.chat.safetyNote}</p>}
      </div>
    );
  }

  return (
    <div className="mt-5">
      <label className="text-sm text-ink-soft" htmlFor="micro-feeling">
        {t.microDone}
      </label>
      <textarea
        id="micro-feeling"
        value={feeling}
        onChange={(e) => setFeeling(e.target.value)}
        placeholder={t.microFeelingPlaceholder}
        rows={2}
        maxLength={500}
        className="mt-2 w-full resize-none border border-line bg-white/60 p-3 text-sm leading-relaxed outline-none focus:border-ink"
      />
      <button
        onClick={submit}
        disabled={state === 'saving'}
        className="mt-3 border border-ink px-4 py-2 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
      >
        {state === 'saving' ? '…' : t.microSave}
      </button>
    </div>
  );
}
