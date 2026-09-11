'use client';

// 日记视图：写/存（免费所有人）→ 条目列表；每条可请求 AI 回应（VIP，付费墙② soft gate 文案）。
// 危机命中的日记：条目照常保存，回应显示转介文案（服务端定死）。
import { useState } from 'react';
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';

interface Entry {
  id: number;
  content: string;
  aiReply: string | null;
  createdAt: string;
}

interface Props {
  locale: string;
  isVip: boolean;
  entries: Entry[];
  dict: Dict['journal'];
}

export default function JournalView({ locale, isVip, entries: initial, dict: t }: Props) {
  const [entries, setEntries] = useState<Entry[]>(initial);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  // 回应进行中/门禁的条目 id；null = 无
  const [replyingId, setReplyingId] = useState<number | null>(null);
  const [gatedId, setGatedId] = useState<number | null>(null);

  async function save() {
    const content = draft.trim();
    if (!content || saving) return;
    setSaving(true);
    setError(false);
    try {
      const res = await fetch('/api/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, locale }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { entry: { id: number; createdAt: string }; safety?: boolean };
      setEntries((prev) => [{ id: data.entry.id, content, aiReply: null, createdAt: data.entry.createdAt }, ...prev]);
      setDraft('');
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  async function requestReply(id: number) {
    if (replyingId !== null) return;
    setGatedId(null);
    setReplyingId(id);
    try {
      const res = await fetch(`/api/journal/${id}/reply`, { method: 'POST' });
      if (res.status === 403) {
        setGatedId(id);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { reply: string };
      setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, aiReply: data.reply } : e)));
    } catch {
      // 失败静默回到可重试状态
    } finally {
      setReplyingId(null);
    }
  }

  return (
    <div className="flex flex-col">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t.placeholder}
        rows={6}
        maxLength={5000}
        className="w-full resize-none border border-line bg-white/60 p-4 text-sm leading-relaxed outline-none focus:border-ink"
      />
      <div className="mt-3 flex items-center gap-4">
        <button
          onClick={save}
          disabled={!draft.trim() || saving}
          className="border border-ink px-5 py-2 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-40"
        >
          {saving ? '…' : t.save}
        </button>
        {error && <p className="text-sm text-ink-soft">{t.error}</p>}
      </div>

      {entries.length === 0 ? (
        <p className="mt-10 text-sm text-ink-soft">{t.empty}</p>
      ) : (
        <ul className="mt-10 flex flex-col">
          {entries.map((e) => (
            <li key={e.id} className="border-t border-line py-6">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{e.content}</p>
              {e.aiReply ? (
                <div className="mt-4 border-l-2 border-line pl-4">
                  <p className="text-xs tracking-widest text-ink-soft">{t.replyLabel}</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{e.aiReply}</p>
                </div>
              ) : (
                <div className="mt-4">
                  <button
                    onClick={() => requestReply(e.id)}
                    disabled={replyingId === e.id}
                    className="text-sm text-accent underline underline-offset-4 disabled:opacity-50"
                  >
                    {replyingId === e.id ? t.replyPending : t.replyBtn}
                  </button>
                  {gatedId === e.id && (
                    <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                      {t.replyVipGate}{' '}
                      <Link href={`/${locale}/vip`} className="text-accent underline underline-offset-4">
                        {t.replyVipCta}
                      </Link>
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!isVip && entries.length > 0 && (
        <p className="mt-8 text-xs leading-relaxed text-ink-soft/70">{t.vipNote}</p>
      )}
    </div>
  );
}
