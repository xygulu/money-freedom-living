'use client';

// 信件视图（简版闭环）：写信 → 交出去（保存 + AI 回信）→ 留着 / 封存 →（封存后）开启。
// 封存的信内容隐藏，开启后可见（state: kept | sealed | opened）。
// 回信失败不阻塞收信：信先存下，回信位置显示提示（MVP 不做补投递）。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';

interface Letter {
  stage: number;
  content: string;
  state: 'kept' | 'sealed' | 'opened';
  aiReply: string | null;
  createdAt: string;
}

export default function LettersView({
  locale,
  letters: initial,
  dict: t,
}: {
  locale: string;
  letters: Letter[];
  dict: Dict['letters'];
}) {
  const [letters, setLetters] = useState<Letter[]>(initial);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const [promptFor, setPromptFor] = useState<string | null>(null); // 开启需确认的封信

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(false);
    try {
      const res = await fetch('/api/letters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, locale }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { letter: Letter };
      setLetters((prev) => [data.letter, ...prev]);
      setDraft('');
    } catch {
      setError(true);
    } finally {
      setSending(false);
    }
  }

  async function transition(letter: Letter, action: 'seal' | 'open') {
    const res = await fetch('/api/letters', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ createdAt: letter.createdAt, action }),
    });
    if (!res.ok) return;
    const next: Letter['state'] = action === 'seal' ? 'sealed' : 'opened';
    setLetters((prev) => prev.map((l) => (l.createdAt === letter.createdAt ? { ...l, state: next } : l)));
    setPromptFor(null);
  }

  return (
    <div className="flex flex-col">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t.placeholder}
        rows={7}
        maxLength={3000}
        className="w-full resize-none border border-line bg-white/60 p-4 text-sm leading-relaxed outline-none focus:border-ink"
      />
      <div className="mt-3 flex items-center gap-4">
        <button
          onClick={send}
          disabled={!draft.trim() || sending}
          className="border border-ink px-5 py-2 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-40"
        >
          {sending ? t.sending : t.send}
        </button>
        {error && <p className="text-sm text-ink-soft">{t.error}</p>}
      </div>
      {sending && <p className="mt-3 text-xs text-ink-soft/70">{t.sendingHint}</p>}

      {letters.length > 0 && (
        <ul className="mt-12 flex flex-col">
          {letters.map((l) => {
            const hidden = l.state === 'sealed';
            return (
              <li key={l.createdAt} className="border-t border-line py-6">
                <p className="text-xs tracking-widest text-ink-soft">
                  {new Date(l.createdAt).toLocaleDateString()} · {t.stateLabel[l.state]}
                </p>

                {hidden ? (
                  promptFor === l.createdAt ? (
                    <div className="mt-4">
                      <p className="text-sm leading-relaxed text-ink-soft">{t.openConfirm}</p>
                      <div className="mt-3 flex gap-4 text-sm">
                        <button onClick={() => transition(l, 'open')} className="text-accent underline underline-offset-4">
                          {t.open}
                        </button>
                        <button onClick={() => setPromptFor(null)} className="text-ink-soft">
                          {t.keepSealed}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setPromptFor(l.createdAt)}
                      className="mt-4 text-sm text-accent underline underline-offset-4"
                    >
                      {t.open}
                    </button>
                  )
                ) : (
                  <>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{l.content}</p>
                    {l.aiReply ? (
                      <div className="mt-4 border-l-2 border-line pl-4">
                        <p className="text-xs tracking-widest text-ink-soft">{t.replyLabel}</p>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{l.aiReply}</p>
                      </div>
                    ) : (
                      <p className="mt-4 text-sm text-ink-soft/70">{t.replyMissing}</p>
                    )}
                    {l.state === 'kept' && (
                      <button
                        onClick={() => transition(l, 'seal')}
                        className="mt-4 text-sm text-ink-soft underline underline-offset-4"
                      >
                        {t.seal}
                      </button>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
