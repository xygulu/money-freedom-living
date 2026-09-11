'use client';

// 陪伴对话视图（M4）：开始卡片（配额预检）↔ 对话间（SSE 流式）。
// 会话建立后立即请求 AI 开场（opener）——归来问候自然接上 memories 里的上次内容。
// 危机命中（safety 事件）时该轮回复是服务端定死的转介文案，样式区分并附安全提示。
import { useState } from 'react';
import { readSse } from '@/lib/sse-client';
import type { Dict } from '@/i18n/get-dict';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  locale: string;
  dict: Dict;
  openSessionId: string | null;
  initialMessages: Turn[];
  remaining: number;
}

export default function ChatView({ locale, dict, openSessionId, initialMessages, remaining }: Props) {
  const t = dict.chat;
  const [sessionId, setSessionId] = useState<string | null>(openSessionId);
  const [messages, setMessages] = useState<Turn[]>(initialMessages);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [exhausted, setExhausted] = useState(remaining <= 0 && !openSessionId);
  const [ended, setEnded] = useState(false);
  const [left, setLeft] = useState(remaining);
  const [safetyShown, setSafetyShown] = useState(false);
  const [error, setError] = useState('');

  const inputDisabled = busy || ended || !sessionId;

  // 发消息（text）或请求开场（null）：SSE 增量合并到末条 assistant
  async function stream(text: string | null) {
    if (!sessionId) return;
    setBusy(true);
    setError('');
    const assistantIndex = messages.length;
    setMessages((prev) => [
      ...prev,
      ...(text ? ([{ role: 'user', content: text }] as Turn[]) : []),
      { role: 'assistant', content: '' },
    ]);
    try {
      const response = await fetch(`/api/chat/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(text ? { message: text } : { opener: true }),
      });
      if (!response.ok || !response.body) {
        setError(dict.onboarding.error);
        setMessages((prev) => prev.slice(0, assistantIndex));
        return;
      }
      let full = '';
      await readSse(response, (event) => {
        if (event.session) return;
        if (event.error) setError(dict.onboarding.error);
        if (event.safety) setSafetyShown(true);
        if (typeof event.delta === 'string') {
          full += event.delta;
          setMessages((prev) => {
            const next = [...prev];
            next[assistantIndex] = { role: 'assistant', content: full };
            return next;
          });
        }
      });
      if (full.trim() === '') setMessages((prev) => prev.slice(0, assistantIndex));
      // 开场即本会话首次 AI 回复成功 = 服务端已落账，前端剩余 -1（真实额度以服务端为准）
      if (full.trim() !== '' && text === null && left > 0) setLeft(left - 1);
    } catch {
      setError(dict.onboarding.error);
      setMessages((prev) => prev.slice(0, assistantIndex));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      if (response.status === 403) {
        setExhausted(true);
        return;
      }
      if (!response.ok) {
        setError(dict.onboarding.error);
        return;
      }
      const data = (await response.json()) as { session: string };
      setSessionId(data.session);
    } catch {
      setError(dict.onboarding.error);
    } finally {
      setBusy(false);
    }
  }

  async function endToday() {
    if (!sessionId) return;
    setBusy(true);
    try {
      await fetch(`/api/chat/${sessionId}`, { method: 'DELETE' });
      setEnded(true);
    } finally {
      setBusy(false);
    }
  }

  // ---- 开始前状态 ----
  if (!sessionId) {
    if (exhausted) {
      return (
        <div className="flex flex-col gap-3 text-sm text-ink-soft">
          <p>{t.quotaExhausted}</p>
          <p className="text-xs">{t.vipHint}</p>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={start}
          className="self-start rounded-full bg-accent px-8 py-3 text-base text-paper hover:opacity-90 disabled:opacity-40"
        >
          {t.start}
        </button>
        <p className="text-xs text-ink-soft">
          {t.remaining}: {left}
        </p>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  // ---- 对话间 ----
  return (
    <div className="flex flex-col">
      <div className="flex max-h-[55vh] min-h-[240px] flex-col gap-4 overflow-y-auto rounded border border-line bg-white/50 p-5">
        {messages.map((turn, i) => (
          <div
            key={i}
            className={
              turn.role === 'user'
                ? 'self-end max-w-[85%] rounded bg-accent/10 px-4 py-2 text-sm'
                : 'self-start max-w-[85%] text-sm leading-relaxed'
            }
          >
            {turn.content
              ? turn.content.split('\n').map((line, j) => (
                  <p key={j} className={j ? 'mt-1' : ''}>
                    {line}
                  </p>
                ))
              : (
                  <span className="text-ink-soft">…</span>
                )}
          </div>
        ))}
      </div>

      {safetyShown && <p className="mt-3 text-xs text-ink-soft">{t.safetyNote}</p>}
      {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

      {!ended && (
        <div className="mt-4 flex items-end gap-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (draft.trim() && !busy) {
                  void stream(draft.trim());
                  setDraft('');
                }
              }
            }}
            rows={2}
            maxLength={2000}
            placeholder={t.inputPlaceholder}
            disabled={inputDisabled}
            className="flex-1 resize-none rounded border border-line bg-white/60 p-3 text-sm outline-none focus:border-accent disabled:opacity-40"
          />
          <button
            type="button"
            disabled={inputDisabled || !draft.trim()}
            onClick={() => {
              void stream(draft.trim());
              setDraft('');
            }}
            className="rounded-full bg-accent px-5 py-2.5 text-sm text-paper hover:opacity-90 disabled:opacity-40"
          >
            {t.send}
          </button>
        </div>
      )}

      {!ended ? (
        <button
          type="button"
          disabled={busy || messages.length === 0}
          onClick={endToday}
          className="mt-4 self-start text-xs text-ink-soft underline underline-offset-4 hover:text-ink disabled:opacity-40"
        >
          {t.endToday}
        </button>
      ) : (
        <p className="mt-4 text-xs text-ink-soft">{t.ended}</p>
      )}
    </div>
  );
}
