'use client';

// 演进提议卡（M9 需求②）：素材攒够时出现——「这段时间你聊了不少新东西，
// 我想重新看看你」。AI 提议 + 用户确认；生成约 45-90 秒，busy 期不给按钮。
// 失败时现画像不动、卡片不消失；「暂不」→ 14 天冷却，绝不打断。
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Dict } from '@/i18n/get-dict';

export default function EvolveCard({ locale, dict }: { locale: string; dict: Dict }) {
  const t = dict.evolve;
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  async function generate() {
    setGenerating(true);
    setError('');
    try {
      const res = await fetch('/api/portrait/evolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, action: 'generate' }),
      });
      if (!res.ok) {
        setError(res.status === 429 ? t.busy : t.failed);
        setGenerating(false);
        return;
      }
      router.push(`/${locale}/portrait/compare`); // 新旧并排，由服务端渲染
    } catch {
      setError(t.failed);
      setGenerating(false);
    }
  }

  async function dismiss() {
    setError('');
    try {
      await fetch('/api/portrait/evolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, action: 'dismiss' }),
      });
      router.refresh();
    } catch {
      setError(dict.me.error);
    }
  }

  return (
    <div className="mt-6 border border-accent/50 bg-white/70 p-6">
      <p className="text-xs tracking-widest text-ink-soft">{t.label}</p>
      <p className="mt-3 text-base leading-relaxed">{t.invite}</p>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{t.hint}</p>
      {generating ? (
        <p className="mt-5 text-sm leading-relaxed text-ink-soft">{t.busy}</p>
      ) : (
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => void generate()}
            className="border border-ink px-5 py-2.5 text-sm transition-colors hover:bg-ink hover:text-paper"
          >
            {t.cta}
          </button>
          <button
            type="button"
            onClick={() => void dismiss()}
            className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
          >
            {t.dismiss}
          </button>
        </div>
      )}
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </div>
  );
}
