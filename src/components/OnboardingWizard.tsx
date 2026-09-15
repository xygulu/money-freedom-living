'use client';

// 体检向导（P0-3 首启重排后的顺序）：
//   欢迎（一句，不问任何题）→ 一段对话 → 「我听到的是…」（前 3 分钟，第一个物件）
//   → 问卷（6 题拆成多段，一次一件、能跳过）→ 复述确认 + 单独同意 → 画像生成 → 完成。
// 两条红线没动：
// - 顺序铁律（docs/05 §7）：先被说中 → 再注册 / 同意 / 定价。同意区仍在"被说中"**之后**。
// - 首屏不出现问卷（docs/10 §P0-3）：进页第一眼是欢迎与对话，不是 6 道题。
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

type Step = 'welcome' | 'talk' | 'echo' | 'form' | 'reflect' | 'generating' | 'done';

export default function OnboardingWizard({ locale, dict }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [summary, setSummary] = useState('');
  // 第一次被说中：对话里拿到的那一句（不等注册、不问同意）
  const [echo, setEcho] = useState('');
  const [echoFailed, setEchoFailed] = useState(false);
  const [echoLoading, setEchoLoading] = useState(false);
  // 问卷一次一件（P0-3：不一次给 6 题）
  const [qi, setQi] = useState(0);
  const [savingForm, setSavingForm] = useState(false);
  const [reflectDone, setReflectDone] = useState(false);
  // 敏感信息单独同意 + 18+ 声明（P§9）：两个独立勾选，不与任何协议打包；
  // 拒绝者可继续用问卷与日记，只是不生成画像、不进行 AI 深谈
  const [adultOk, setAdultOk] = useState(false);
  const [sensitiveOk, setSensitiveOk] = useState(false);
  // 触达同意（M11-E）：与上面两项各自独立，默认不勾，不勾照样能往下走——
  // 打包勾选在 GDPR 下不成立，而且"不收信"本来就该是无代价的（docs/05 §9.3）
  const [touchOk, setTouchOk] = useState(false);
  const [supplement, setSupplement] = useState('');
  const [error, setError] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 首次"说中了"耗时的起点：进到这个页面的那一刻（指标见 docs/05 §7）。
  // 首启重排后起点仍是落地那一刻——欢迎屏、对话、问卷都算在这 3 分钟里，
  // 所以问卷必须排在"被说中"之后（否则它会把这一句顶出 3 分钟）。
  const startedAtRef = useRef(Date.now());

  const o = dict.onboarding;
  const userTurns = turns.filter((t) => t.role === 'user').length;
  const canGenerate = userTurns >= 3;

  function setAnswer(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  /** form 步最后一题触发：提交问卷答案进档 + 进 reflect 步（commit ffd34ad P0-3 设计稿顺序）。
   *  全跳过也允许——服务端空答会拒，这里先兜住（不调 API，直接 reflect）。 */
  async function submitAnswersAndReflect(): Promise<void> {
    const answerable = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
    if (Object.keys(answerable).length > 0) {
      setSavingForm(true);
      try {
        const response = await fetch('/api/onboarding/answers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locale, answers: answerable }),
        });
        if (!response.ok) throw new Error(String(response.status));
      } catch {
        setError(true);
        return; // 失败停在 form 步，让他能再点
      } finally {
        setSavingForm(false);
      }
    }
    setStep('reflect');
    void goReflect();
  }

  /** 对话里 →「我听到的是…」：素材是**他刚说的话**，不是问卷（P0-3 主素材） */
  async function loadEcho() {
    setEchoLoading(true);
    try {
      const response = await fetch('/api/onboarding/reflect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          locale,
          mode: 'echo',
          elapsedMs: Date.now() - startedAtRef.current,
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as { summary: string };
      if (!data.summary.trim()) throw new Error('empty');
      setEcho(data.summary);
    } catch {
      setEchoFailed(true);
    } finally {
      setEchoLoading(false);
    }
  }

  async function goEcho() {
    setStep('echo');
    await loadEcho();
  }

  /** 从 echo 步进 form 步（仅切状态，提交+reflect 由最后一题的 submitAnswersAndReflect 负责） */
  async function goForm() {
    setStep('form');
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

  async function goTalk() {
    setStep('talk');
    if (!sessionId) await startTalk();
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
    if (!sessionId) {
      setReflectDone(true);
      return;
    }
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
    } finally {
      setReflectDone(true);
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
      // 勾了才记：没勾 = 没表态，不给他写一条"拒绝"记录
      if (touchOk) {
        await fetch('/api/touch/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ optIn: true }),
        }).catch(() => {}); // 触达是可选项，记不上也不该挡住画像
      }
      setStep('done');
    } catch {
      setError(true);
      setStep('reflect');
    }
  }

  // ---------- 各步渲染 ----------

  // 首屏：一句欢迎 + 直接开始一段对话。不问任何题（P0-3）
  if (step === 'welcome') {
    return (
      <div className="flex flex-col pt-16" data-step="welcome">
        <h1 className="text-2xl font-medium leading-relaxed tracking-tight">{o.welcome.title}</h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">{o.welcome.sub}</p>
        <button
          type="button"
          onClick={goTalk}
          className="mt-10 self-start rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90"
        >
          {o.welcome.start}
        </button>
      </div>
    );
  }

  if (step === 'talk') {
    return (
      <div className="flex flex-col pt-12" data-step="talk">
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
        {userTurns >= 1 && !streaming && (
          <button
            type="button"
            onClick={goEcho}
            className="mt-6 self-start rounded-full border border-accent px-6 py-2 text-sm text-accent hover:bg-accent hover:text-paper"
          >
            {o.echo.title} →
          </button>
        )}
      </div>
    );
  }

  // 第一个物件：对话里拿到的那一句。这一步不要注册、不问同意、不提价钱
  if (step === 'echo') {
    return (
      <div className="flex flex-col pt-12" data-step="echo">
        <h2 className="text-xl font-medium">{o.echo.title}</h2>
        {echo && (
          <div data-echo className="mt-6 whitespace-pre-wrap border border-line bg-white/60 p-5 text-base leading-loose">
            {echo}
          </div>
        )}
        {!echo && !echoFailed && (echoLoading || !echo) && <p className="mt-6 animate-pulse text-sm text-ink-soft">{o.echo.loading}</p>}
        {echoFailed && <p className="mt-6 text-sm text-ink-soft">{o.echo.fallback}</p>}
        {(echo || echoFailed) && (
          <>
            <p className="mt-6 text-sm leading-relaxed text-ink-soft">{echoFailed ? o.talk.hint : o.echo.hint}</p>
            <button
              type="button"
              onClick={goForm}
              className="mt-8 self-start rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90"
            >
              {o.echo.next} →
            </button>
            {echo && (
              <button type="button" onClick={goTalk} className="mt-3 self-start text-sm text-ink-soft underline underline-offset-4 hover:text-ink">
                {o.echo.amend}
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  // 被说中之后的体检：6 题拆成多段，一次一件，跳过的没有任何代价
  if (step === 'form') {
    const q = QUESTIONS[qi];
    const qd = (o.questions as Record<string, { text: string; options?: Record<string, string>; placeholder?: string }>)[q.id];
    const last = qi === QUESTIONS.length - 1;
    const advance = () => (last ? void submitAnswersAndReflect() : setQi((n) => n + 1));
    return (
      <div className="flex flex-col pt-12" data-step="form">
        <h2 className="text-xl font-medium">{o.form.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{o.form.progress}</p>
        <p className="mt-8 text-xs text-ink-soft" data-form-progress>
          {qi + 1} / {QUESTIONS.length}
        </p>
        <p className="mt-2 text-sm leading-relaxed" data-question={q.id}>
          {qd.text}
        </p>
        {q.kind === 'choice' && qd.options ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {q.options!.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setAnswer(q.id, value);
                  advance();
                }}
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
            placeholder={qd.placeholder ?? o.form.placeholder}
            rows={2}
            maxLength={500}
            className="mt-4 w-full resize-none rounded border border-line bg-white/60 p-3 text-sm leading-relaxed outline-none focus:border-accent"
          />
        )}
        {error && <p className="mt-4 text-sm text-red-700">{o.error}</p>}
        <div className="mt-8 flex items-center gap-4">
          {q.kind !== 'choice' && (
            <button
              type="button"
              onClick={advance}
              disabled={savingForm}
              className="rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {o.form.next}
            </button>
          )}
          <button
            type="button"
            onClick={advance}
            disabled={savingForm}
            className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink disabled:opacity-40"
          >
            {o.form.skip}
          </button>
        </div>
      </div>
    );
  }

  if (step === 'reflect') {
    // 顺序铁律（docs/05 §7）：同意区只在他已经被说中之后才出现——
    // echo 是前 3 分钟那一句，summary 是初谈复述，两者都没拿到就等这一步结束再放行
    const beenSeen = Boolean(echo || summary) || reflectDone;
    return (
      <div className="flex flex-col pt-12" data-step="reflect">
        <h2 className="text-xl font-medium">{o.reflect.title}</h2>
        {summary && <div className="mt-6 whitespace-pre-wrap border border-line bg-white/60 p-5 text-sm leading-relaxed">{summary}</div>}
        {!summary && <p className="mt-6 text-sm text-ink-soft">{o.talk.hint}</p>}
        <div className="mt-8 flex flex-col gap-3">
          {/* 单独同意区（P§9）：两项各自独立、默认不勾、拒绝不影响问卷/日记使用 */}
          {beenSeen && (
          <div data-consent className="flex flex-col gap-3 border border-line bg-white/60 p-5 text-sm">
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" checked={adultOk} onChange={(e) => setAdultOk(e.target.checked)} className="mt-1" />
              <span>{o.consent.adultLabel}</span>
            </label>
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" checked={sensitiveOk} onChange={(e) => setSensitiveOk(e.target.checked)} className="mt-1" />
              <span className="leading-relaxed">{o.consent.sensitiveLabel}</span>
            </label>
            <p className="text-xs leading-relaxed text-ink-soft">{o.consent.sensitiveHint}</p>
            <label data-touch-optin className="mt-1 flex cursor-pointer items-start gap-3 border-t border-dashed border-line pt-3">
              <input type="checkbox" checked={touchOk} onChange={(e) => setTouchOk(e.target.checked)} className="mt-1" />
              <span className="leading-relaxed">{dict.touch.optInLabel}</span>
            </label>
            <p className="text-xs leading-relaxed text-ink-soft">{dict.touch.optInHint}</p>
          </div>
          )}
          {beenSeen && (
          <button
            type="button"
            onClick={generatePortrait}
            disabled={!adultOk || !sensitiveOk || (canGenerate === false && userTurns === 0)}
            className="self-start rounded-full bg-accent px-6 py-2 text-sm text-paper hover:opacity-90 disabled:opacity-40"
          >
            {o.reflect.confirm} · {o.reflect.next}
          </button>
          )}
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
