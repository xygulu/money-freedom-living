'use client';

// 体检向导：问卷 → AI 初谈（SSE 流式）→「我听到的是」确认 → 画像生成 → 完成。
// 状态机五步；对话区极简（气泡式，纸感配色与全站一致）。
import { useRef, useState } from 'react';
import Link from 'next/link';
import { QUESTIONS } from '@/lib/onboarding';
import { readSse } from '@/lib/sse-client';
import type { Dict } from '@/i18n/get-dict';
import type { Locale } from '@/i18n/config';

interface Props {
  locale: Locale;
  dict: Dict;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

type Step = 'survey' | 'talk' | 'reflect' | 'generating' | 'done';

export default function OnboardingWizard({ locale, dict }: Props) {
  const [step, setStep] = useState<Step>('survey');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [summary, setSummary] = useState('');
  // 敏感信息单独同意 + 18+ 声明（P§9）：两个独立勾选，不与任何协议打包；
  // 拒绝者可继续用问卷与日记，只是不生成画像、不进行 AI 深谈
  const [adultOk, setAdultOk] = useState(false);
  const [sensitiveOk, setSensitiveOk] = useState(false);
  const [supplement, setSupplement] = useState('');
  const [error, setError] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const o = dict.onboarding;
  const userTurns = turns.filter((t) => t.role === 'user').length;
  const canGenerate = userTurns >= 3;

  function setAnswer(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  async function submitSurvey() {
    setError(false);
    try {
      const response = await fetch('/api/onboarding/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, answers }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setStep('talk');
      await startTalk();
    } catch {
      setError(true);
    }
  }

  async function startTalk() {
    setStreaming(true);
    try {
      const response = await fetch('/api/onboarding/talk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      let sid: string | null = null;
      await readSse(response, (event) => {
        if (event.session) sid = event.session;
        if (event.delta) {
          setTurns((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              return [...prev.slice(0, -1), { role: 'assistant', content: last.content + event.delta }];
            }
            return [...prev, { role: 'assistant', content: event.delta ?? '' }];
          });
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
        if (event.error) setError(true);
      });
      if (sid) setSessionId(sid);
    } catch {
      setError(true);
    } finally {
      setStreaming(false);
    }
  }

  async function sendMessage(text: string, silent = false) {
    if (!sessionId || !text.trim()) return;
    setTurns((prev) => [...prev, { role: 'user', content: text }]);
    if (silent) {
      await fetch(`/api/chat/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, silent: true }),
      }).catch(() => setError(true));
      return;
    }
    setStreaming(true);
    try {
      const response = await fetch(`/api/chat/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      await readSse(response, (event) => {
        if (event.delta) {
          setTurns((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              return [...prev.slice(0, -1), { role: 'assistant', content: last.content + event.delta }];
            }
            return [...prev, { role: 'assistant', content: event.delta ?? '' }];
          });
          bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
        if (event.error) setError(true);
      });
    } catch {
      setError(true);
    } finally {
      setStreaming(false);
    }
  }

  async function goReflect() {
    if (!sessionId) return setStep('reflect');
    setStep('reflect');
    try {
      const response = await fetch('/api/onboarding/reflect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, locale }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as { summary: string };
      setSummary(data.summary);
    } catch {
      setSummary(''); // 复述失败不阻塞：确认步可跳过，画像仍可生成
    }
  }

  async function generatePortrait() {
    if (!adultOk || !sensitiveOk) return;
    setStep('generating');
    try {
      const response = await fetch('/api/onboarding/portrait', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, sessionId, consent: true }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setStep('done');
    } catch {
      setError(true);
      setStep('reflect');
    }
  }

  // ---------- 各步渲染 ----------

  if (step === 'survey') {
    const answerable = QUESTIONS.filter((q) => answers[q.id]?.trim());
    return (
      <div className="flex flex-col pt-12">
        <h1 className="text-2xl font-medium tracking-tight">{o.title}</h1>
        <div className="mt-8 flex flex-col gap-8">
          {QUESTIONS.map((q, i) => {
            const qd = (o.questions as Record<string, { text: string; options?: Record<string, string>; placeholder?: string }>)[q.id];
            return (
              <div key={q.id}>
                <p className="text-sm leading-relaxed">
                  <span className="text-ink-soft">{i + 1}.</span> {qd.text}
                </p>
                {q.kind === 'choice' && qd.options ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {q.options!.map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setAnswer(q.id, value)}
                        className={`rounded-full border px-4 py-2 text-sm transition-colors ${
                          answers[q.id] === value ? 'border-accent bg-accent text-paper' : 'border-line text-ink-soft hover:text-ink'
                        }`}
                      >
                        {qd.options![value]}
                      </button>
                    ))}
                  </div>
                ) : (
                  <textarea
                    value={answers[q.id] ?? ''}
                    onChange={(e) => setAnswer(q.id, e.target.value)}
                    placeholder={qd.placeholder}
                    rows={2}
                    maxLength={500}
                    className="mt-3 w-full resize-none rounded border border-line bg-white/60 p-3 text-sm leading-relaxed outline-none focus:border-accent"
                  />
                )}
              </div>
            );
          })}
        </div>
        {error && <p className="mt-4 text-sm text-red-700">{o.error}</p>}
        <button
          type="button"
          onClick={submitSurvey}
          disabled={answerable.length === 0}
          className="mt-10 rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {o.talk.title} →
        </button>
      </div>
    );
  }

  if (step === 'talk') {
    return (
      <div className="flex flex-col pt-12">
        <h1 className="text-2xl font-medium tracking-tight">{o.talk.title}</h1>
        <p className="mt-2 text-sm text-ink-soft">{o.talk.hint}</p>
        <div className="mt-6 flex min-h-[40vh] flex-col gap-4">
          {turns.map((turn, i) => (
            <div
              key={i}
              className={turn.role === 'user' ? 'self-end rounded-2xl rounded-br-sm bg-accent/10 px-4 py-3 text-sm leading-relaxed' : 'self-start rounded-2xl rounded-bl-sm border border-line bg-white/60 px-4 py-3 text-sm leading-relaxed'}
            >
              {turn.content}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        {error && <p className="mt-4 text-sm text-red-700">{o.error}</p>}
        <TalkInput disabled={streaming} onSend={(text) => sendMessage(text)} />
        {canGenerate && !streaming && (
          <button type="button" onClick={goReflect} className="mt-6 self-start rounded-full border border-accent px-6 py-2 text-sm text-accent hover:bg-accent hover:text-paper">
            {o.talk.done} · {o.talk.generate}
          </button>
        )}
      </div>
    );
  }

  if (step === 'reflect') {
    return (
      <div className="flex flex-col pt-12">
        <h2 className="text-xl font-medium">{o.reflect.title}</h2>
        {summary && <div className="mt-6 whitespace-pre-wrap border border-line bg-white/60 p-5 text-sm leading-relaxed">{summary}</div>}
        {!summary && <p className="mt-6 text-sm text-ink-soft">{o.talk.hint}</p>}
        <div className="mt-8 flex flex-col gap-3">
          {/* 单独同意区（P§9）：两项各自独立、默认不勾、拒绝不影响问卷/日记使用 */}
          <div className="flex flex-col gap-3 border border-line bg-white/60 p-5 text-sm">
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" checked={adultOk} onChange={(e) => setAdultOk(e.target.checked)} className="mt-1" />
              <span>{o.consent.adultLabel}</span>
            </label>
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" checked={sensitiveOk} onChange={(e) => setSensitiveOk(e.target.checked)} className="mt-1" />
              <span className="leading-relaxed">{o.consent.sensitiveLabel}</span>
            </label>
            <p className="text-xs leading-relaxed text-ink-soft">{o.consent.sensitiveHint}</p>
          </div>
          <button
            type="button"
            onClick={generatePortrait}
            disabled={!adultOk || !sensitiveOk}
            className="self-start rounded-full bg-accent px-6 py-2 text-sm text-paper hover:opacity-90 disabled:opacity-40"
          >
            {o.reflect.confirm} · {o.reflect.next}
          </button>
          <div className="flex gap-2">
            <input
              value={supplement}
              onChange={(e) => setSupplement(e.target.value)}
              placeholder={o.reflect.supplement}
              maxLength={500}
              className="flex-1 rounded border border-line bg-white/60 p-3 text-sm outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={!supplement.trim()}
              onClick={async () => {
                await sendMessage(supplement.trim(), true);
                setSupplement('');
              }}
              className="rounded border border-line px-4 text-sm text-ink-soft hover:text-ink disabled:opacity-40"
            >
              {o.reflect.send}
            </button>
          </div>
        </div>
        {error && <p className="mt-4 text-sm text-red-700">{o.error}</p>}
      </div>
    );
  }

  if (step === 'generating') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center pt-12 text-center">
        <p className="animate-pulse text-sm text-ink-soft">{o.generating}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center pt-20 text-center">
      <p className="text-lg">{dict.landing.hero}</p>
      <Link href={`/${locale}/portrait`} className="mt-8 rounded-full bg-accent px-8 py-3 text-base text-paper hover:opacity-90">
        {o.portraitLink} →
      </Link>
    </div>
  );
}

function TalkInput({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <form
      className="mt-4 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSend(text.trim());
        setText('');
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
        maxLength={2000}
        className="flex-1 rounded border border-line bg-white/60 p-3 text-sm outline-none focus:border-accent disabled:opacity-50"
      />
      <button type="submit" disabled={disabled || !text.trim()} className="rounded bg-accent px-5 text-sm text-paper disabled:opacity-40">
        →
      </button>
    </form>
  );
}
