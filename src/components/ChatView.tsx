'use client';

// 陪伴对话视图（M4）：开始卡片（配额预检）↔ 对话间（SSE 流式）。
// 会话建立后立即请求 AI 开场（opener）——归来问候自然接上 memories 里的上次内容。
// 危机命中（safety 事件）时该轮回复是服务端定死的转介文案，样式区分并附安全提示。
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
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
  /** 从旅程页点「随便聊聊」进来：落地即开聊，不再要第二次点击 */
  autoStart?: boolean;
}

export default function ChatView({ locale, dict, openSessionId, initialMessages, remaining, autoStart = false }: Props) {
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
  // 流中途切 provider 提示（已显示文本不回收；仅在助手气泡下方灰色小字）
  const [switchedHint, setSwitchedHint] = useState<string | null>(null);
  // 自动开聊只许一次：StrictMode 下 effect 会跑两遍，ref 同实例保留，避免建出两个会话
  const autoStarted = useRef(false);
  const openerAsked = useRef(false);

  const inputDisabled = busy || ended || !sessionId;

  // 落地即开聊（?start=1）：旅程页那一下点击已经是「我想聊」，这里不该再要一次点击。
  // 只在没有进行中的会话时建；失败会落回开始按钮（下面的 error 分支）。
  useEffect(() => {
    if (!autoStart || autoStarted.current || openSessionId) return;
    autoStarted.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 归来问候：一条消息都还没有的会话，由它先开口（接上 memories 里的上次内容），
  // 别让人对着空白自己找话头。续上的旧会话已有消息，这里天然不触发。
  // 额度语义：opener 就是本会话首条 AI 回复，落账即「新开了一段对话」——
  // 而新开一段本来就该记 1 次，续聊不再扣，所以这里不会凭空多扣。
  useEffect(() => {
    if (!sessionId || openerAsked.current || messages.length > 0 || ended) return;
    openerAsked.current = true;
    void stream(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

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
    setSwitchedHint(null); // 每轮重置（切 provider 才再次点亮）
    try {
      const response = await fetch(`/api/chat/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(text ? { message: text } : { opener: true }),
      });
      if (response.status === 429) {
        // 上一条回复还在生成（会话级流互斥）：不报错，草稿放回输入框，等流结束再发
        setError(t.replyInProgress);
        setMessages((prev) => prev.slice(0, assistantIndex));
        if (text) setDraft(text);
        return;
      }
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
        if (event.providerSwitch) {
          // 多 provider 自动切换提示（i18n: provider.switchedHint）
          // 已显示文本不回收——前端不要清空 full；marker 在流末尾时仍生效
          setSwitchedHint(t.providerSwitchedHint ?? '');
        }
        if (event.wrap) {
          // 20 轮温和收尾（服务端 chat.ts CHAT_MAX_MESSAGES=40 含 AI=20 轮用户+AI）。
          // 输入框置灰 + ended 置位；不写 messages——wrap.delta 是收尾文案，
          // 但已发过 wrap=true 本身就告诉前端"这场对话到限"，UI 端按 ended 兜底
          // （首条 AI 回复未生成时不调 appendMessage，无文本落库；用户在 history
          // 回看时看到的是上一次正常回复 + wrap 通知）
          setEnded(true);
          return;
        }
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
          {/* 付费墙触发点①（soft gate）：会话用完时提 VIP，全产品仅三处之一 */}
          <p className="text-xs">
            {t.vipHint}{' '}
            <Link href={`/${locale}/vip`} className="text-accent underline underline-offset-4">
              {dict.vip.vipLink}
            </Link>
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        {autoStart && !error ? (
          // 带着「我要聊」的意图进来：从首帧起就是「正在打开」，不给一颗还要再按的按钮。
          // 关键是不要等 effect 跑完才切——SSR 首帧到 hydration 之间那一小段里，
          // 旧写法（busy && autoStart）仍会画出开始按钮，用户就会以为还得点一次。
          <p data-chat-opening className="text-sm text-ink-soft">
            {t.opening}
          </p>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={start}
            className="self-start rounded-full bg-accent px-8 py-3 text-base text-paper hover:opacity-90 disabled:opacity-40"
          >
            {t.start}
          </button>
        )}
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
            {/* 多 provider 自动切换：仅在末条 assistant 下显示一次灰色小字 */}
            {i === messages.length - 1 && turn.role === 'assistant' && switchedHint && (
              <p className="mt-1 text-xs text-ink-soft">{switchedHint}</p>
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
