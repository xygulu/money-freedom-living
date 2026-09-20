'use client';

// 前台改造（70-2 C3）· 球点开后的弹层。
// 2026-09-18 弹层 chat 化（用户反馈"里面内容是空的，发送没反应"）：
// - 会话：kind='companion'（/api/chat/sessions body.kind），首条发送时惰性创建；
//   mount 时从 /api/chat/recent 找 open 的 companion 会话续聊（+ 展示 closed 历史）
// - 发送：POST /api/chat/[sessionId] SSE 流式（复用 readSse），与 /chat 同通道
// - 历史：「上次说到这儿」列出最近 closed 会话（chat+companion，排除体检初谈）
// - 关闭：有内容则后台 DELETE（companion 关闭不写 memory，见 [sessionId] route）
// - 无自动 opener：AI 只在用户开口后说话——opener 即首条 AI 回复，会占配额，
//   弹层"只是看看"不该悄悄扣次数
//
// 2026-09-18 样式统一（用户反馈"字体和其他地方不一致""保持展示的样式和形式统一"）：
// 气泡/输入框/按钮的视觉形式与 ChatView（/chat）完全同款——user 气泡
// bg-accent/10 右对齐、assistant 无气泡纯文本左对齐、textarea + bg-accent 圆角
// 发送钮、灰色软提示同型；字体继承 body 全站衬线栈；颜色走全局 token，
// 不再走 scene-* 主题变量。弹层只保留结构壳（遮罩/面板/关闭钮，见 module.css）。
//
// 四种模式（presence / hint / hintToday / door）只影响标题四件套；nudge 文案
// 作为 quote 条 + openingLine 传给后端进 system（AI 接得上气泡里说过的话）。
import { useEffect, useRef, useState } from 'react';
import { readSse } from '@/lib/sse-client';
import type { Dict } from '@/i18n/get-dict';
import styles from './CompanionChat.module.css';

export type CompanionChatMode = 'presence' | 'hint' | 'hintToday' | 'door';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export interface RecentBundle {
  id: string;
  kind: string;
  status: string;
  /** 服务端按 cookie 时区算的日（兜底）；弹层优先用浏览器本机时区重算 */
  day: string;
  closedAt?: string | null;
  createdAt?: string;
  messages: Turn[];
}

/**
 * 历史日期：客户端用浏览器本机时区计算（Intl 不传 timeZone = 本机时区）。
 * 用户 2026-09-18 反馈"要根据用户的时区来自动判断"——比服务端按 cookie 算更可靠
 * （mfl_tz 首帧才写入，首次会话/某些浏览器配置下可能缺失落回 UTC，日期会偏一天）。
 */
function dayLabel(bundle: RecentBundle): string {
  const raw = bundle.closedAt ?? bundle.createdAt;
  if (!raw) return bundle.day;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return bundle.day;
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

interface Props {
  onClose: () => void;
  /** 弹层所在页的 locale（创建会话用） */
  locale: string;
  /** nudge 文案（气泡刚说的话）：quote 条 + 首条发送时的 openingLine */
  dictNudge?: string | null;
  /** 弹层模式（标题四件套） */
  mode?: CompanionChatMode;
  dict: Dict;
}

/** 与 ChatView（/chat）同款气泡形式：user=右对齐 accent/10 圆角块；assistant=左对齐纯文本 */
function turnClass(role: Turn['role']): string {
  return role === 'user'
    ? 'self-end max-w-[85%] rounded bg-accent/10 px-4 py-2 text-sm'
    : 'self-start max-w-[85%] text-sm leading-relaxed';
}

/** 与 ChatView 同款的逐行渲染（换行成 <p>；空内容显示流式占位 …） */
function TurnBody({ turn }: { turn: Turn }) {
  if (!turn.content) return <span className="text-ink-soft">…</span>;
  return (
    <>
      {turn.content.split('\n').map((line, j) => (
        <p key={j} className={j ? 'mt-1' : ''}>
          {line}
        </p>
      ))}
    </>
  );
}

export default function CompanionChat({
  onClose,
  locale,
  dictNudge = null,
  mode = 'presence',
  dict,
}: Props) {
  const t = dict.companion;
  const m = t.chatMode[mode];
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Turn[]>([]);
  const [past, setPast] = useState<RecentBundle[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const creatingRef = useRef(false);

  // mount：**每次打开都拉新鲜数据**（2026-09-18 修正）——此前吃 Companion 页面加载时
  // 的 localStorage 缓存（5min TTL），关闭弹窗后再打开看到的是旧历史、缺刚聊的
  // 内容（用户反馈 #3）。每次打开一次小 GET，正确性优先于缓存优化。
  // 拆分：live（open companion 续聊）+ past（closed 列表）。
  useEffect(() => {
    let cancelled = false;
    async function load() {
      let bundles: RecentBundle[] = [];
      try {
        const res = await fetch('/api/chat/recent?limit=10', { headers: { 'Cache-Control': 'no-store' } });
        if (res.ok) {
          const data = (await res.json()) as { sessions?: RecentBundle[] };
          bundles = Array.isArray(data.sessions) ? data.sessions : [];
        }
      } catch {
        // 网络抖动：历史拿不到不挡弹层，past 留空
      }
      if (cancelled) return;
      const live = bundles.find((b) => b.kind === 'companion' && b.status === 'open');
      if (live && live.messages.length > 0) {
        setSessionId(live.id);
        setMessages(live.messages);
      }
      setPast(
        bundles.filter((b) => b.messages.length > 0 && b.id !== live?.id && b.status === 'closed').slice(0, 6)
      );
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 新助手气泡出现时滚到底（历史很长时也落在最新）
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ESC 关闭（与点 × 同路径）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, messages.length]);

  function handleClose() {
    // 有内容的会话后台关闭（不阻塞 UI；companion 关闭不写 memory）。
    // 空会话留着无妨：下次弹层会被服务端复用，不堆积可见数据。
    if (sessionId && messages.length > 0) {
      void fetch(`/api/chat/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    onClose();
  }

  async function ensureSession(): Promise<string | null> {
    if (sessionId) return sessionId;
    if (creatingRef.current) return null;
    creatingRef.current = true;
    try {
      const res = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, kind: 'companion' }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { session?: string };
      if (!data.session) return null;
      setSessionId(data.session);
      return data.session;
    } catch {
      return null;
    } finally {
      creatingRef.current = false;
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy || ended) return;
    setBusy(true);
    setSendFailed(false);
    setDraft('');
    const assistantIndex = messages.length;
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    try {
      const sid = await ensureSession();
      if (!sid) {
        setMessages((prev) => prev.slice(0, assistantIndex));
        setDraft(text);
        setSendFailed(true);
        return;
      }
      // openingLine 只在会话第一轮传：AI 要知道气泡里说过什么才接得上
      const isFirstTurn = messages.length === 0;
      const response = await fetch(`/api/chat/${sid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, ...(isFirstTurn && dictNudge ? { openingLine: dictNudge } : {}) }),
      });
      if (response.status === 429) {
        // 上一条回复还在生成：草稿放回输入框，不报错
        console.warn('[companion-chat] 429 reply_in_progress');
        setMessages((prev) => prev.slice(0, assistantIndex));
        setDraft(text);
        return;
      }
      if (!response.ok || !response.body) {
        // 403 配额用完 / 401 / 500 统一软提示（产品口径：不展示红字）
        console.warn('[companion-chat] non-ok response:', response.status);
        setMessages((prev) => prev.slice(0, assistantIndex));
        setDraft(text);
        setSendFailed(true);
        return;
      }
      let received = false;
      await readSse(response, (event) => {
        if (event.session) return;
        if (event.error) console.warn('[companion-chat] sse event.error:', event.error);
        if (event.wrap) {
          setEnded(true);
          return;
        }
        if (typeof event.delta === 'string') {
          received = true;
          setMessages((prev) => {
            const next = [...prev];
            const last = next.length - 1;
            if (last >= 0 && next[last].role === 'assistant') {
              next[last] = { role: 'assistant', content: next[last].content + event.delta };
            }
            return next;
          });
        }
      });
      if (!received) {
        // 空流（LLM 全 provider 失败）：assistant 占位泡撤掉，草稿放回
        setMessages((prev) => prev.slice(0, assistantIndex));
        setDraft(text);
        setSendFailed(true);
      }
    } catch (error) {
      console.warn('[companion-chat] send failed:', error);
      setMessages((prev) => prev.slice(0, assistantIndex));
      setDraft(text);
      setSendFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const inputDisabled = busy || ended;

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-label={t.aria}>
      <div className={styles.panel}>
        <header className="border-b border-line pb-2.5">
          {/* 标题行：标题左、关闭钮右，同行居中——与「今天这一步」确认弹层同款（用户 2026-09-18） */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 text-base font-medium tracking-wide text-ink">{m.title}</div>
            <button type="button" className={styles.close} aria-label={dict.companion.exitHint} onClick={handleClose}>
              ×
            </button>
          </div>
          <p className="mt-1 text-[13px] text-ink-soft">{m.sub}</p>
        </header>

        {dictNudge && (
          <p className="mt-2.5 border-l-2 border-line pl-2.5 text-xs leading-relaxed text-ink-soft">
            <span className="mr-1.5">{t.quoteLabel}</span>
            {dictNudge}
          </p>
        )}

        <div ref={bodyRef} className="mt-3 flex flex-1 flex-col gap-3 overflow-y-auto px-0.5 py-1">
          {messages.length === 0 && past.length === 0 && (
            <div className="py-12 text-center text-sm leading-relaxed text-ink-soft">{t.chatHistoryNone}</div>
          )}

          {/* 「上次说到这儿」**始终显示**（在当前对话上方）——2026-09-18 修正：
              原条件 messages.length === 0 才渲染，一发消息历史就整体消失（用户反馈 #2）。
              块序反转：API 给的是最新在前，阅读流要正序——旧段在上、最新一段贴着
              当前对话，读起来才是"从上次聊到这次"（用户反馈：最新在上面很别扭） */}
          {past.length > 0 && (
            <div>
              <div className="text-xs text-ink-soft">{t.chatHistoryLabel}</div>
              {[...past].reverse().map((b) => (
                <div key={b.id} className="mt-2.5 border-l border-line pl-3">
                  <div className="text-[11px] text-ink-soft">{dayLabel(b)}</div>
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {b.messages.slice(-4).map((turn, i) => (
                      <div key={i} className={`${turnClass(turn.role)} opacity-60`}>
                        <TurnBody turn={turn} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {messages.map((turn, i) => (
            <div key={i} className={turnClass(turn.role)}>
              <TurnBody turn={turn} />
            </div>
          ))}
          {ended && <p className="text-center text-xs text-ink-soft">{t.chatEnded}</p>}
        </div>

        {!ended && (
          <div className="mt-3 flex items-end gap-3 border-t border-line pt-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (draft.trim() && !busy) {
                    void send();
                  }
                }
              }}
              rows={2}
              maxLength={2000}
              placeholder={t.chatPlaceholder}
              disabled={inputDisabled}
              className="flex-1 resize-none rounded border border-line bg-white/60 p-3 text-sm outline-none focus:border-accent disabled:opacity-40"
            />
            <button
              type="button"
              disabled={inputDisabled || !draft.trim()}
              onClick={() => void send()}
              className="rounded-full bg-accent px-5 py-2.5 text-sm text-paper hover:opacity-90 disabled:opacity-40"
            >
              {t.chatSend}
            </button>
          </div>
        )}

        {sendFailed && <p className="mt-2 text-center text-xs text-ink-soft">{t.chatSendFailed}</p>}
        <p className="mt-2 text-center text-xs text-ink-soft">{m.foot}</p>
      </div>
    </div>
  );
}
