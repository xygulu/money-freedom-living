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
  // 6 轮温和收尾（产品口径 2026-09-16）：userTurns >= TALK_MAX_USER_MESSAGES 且流结束后
  // 置位 → 输入框 disabled、显示主按钮"差不多了，去看看 →"；不走生硬跳转。
  const [talkFinished, setTalkFinished] = useState(false);
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
  // 产品口径（2026-09-16 用户反馈「前端还是一样的报错提示」）：
  // 用户**绝不**应该看到「出了点问题，请重试」这种由后台报错转化来的文案。
  // 任何服务端/网络异常都走"静默兜底"——console.warn 留痕，
  // UI 兜底为跳 echo 步（最自然的出口），不向用户展示任何红字错误。
  // 此 state 保留为可扩展接口（后续可细分软提示文案），当前默认不渲染。
  const [softHint, setSoftHint] = useState<string | null>(null);
  // 多 provider 切换提示（已显示文本不回收；每轮重置）
  const [switchedHint, setSwitchedHint] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 首次"说中了"耗时的起点：进到这个页面的那一刻（指标见 docs/05 §7）。
  // 首启重排后起点仍是落地那一刻——欢迎屏、对话、问卷都算在这 3 分钟里，
  // 所以问卷必须排在"被说中"之后（否则它会把这一句顶出 3 分钟）。
  const startedAtRef = useRef(Date.now());

  const o = dict.onboarding;
  const userTurns = turns.filter((t) => t.role === 'user').length;
  const canGenerate = userTurns >= 3;
  // 派生：userTurns 达到服务端上限即视为聊够了（不依赖服务端 wrap 事件；
  // onboarding 路径服务端不发 wrap，前端数满即视为温和收尾时机）
  // 6 是与 src/lib/chat.ts:22 TALK_MAX_USER_MESSAGES 镜像的 UI 上限
  const reachedTalkLimit = userTurns >= 6;

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
      } catch (err) {
        // 问卷入库失败：用户已点过提交，给他一个轻提示让他能再点，
        // 但**不展示"请重试"红字**——产品口径：报错不出现在用户眼前。
        // softHint 只展示一行文案，按钮仍在，可以直接重试。
        console.warn('[onboarding/answers] submit failed:', err);
        setSoftHint('网络不太顺，再点一次试试');
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
    setSwitchedHint(false);
    try {
      const response = await fetch('/api/onboarding/talk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      // 非 2xx（LLM 未配置等）：错误兜底，避免 readSse 在非 OK 上抛错
      // 留下半截 stream 状态
      if (!response.ok) {
        // 服务端初始化失败（LLM 未配置等）：**不展示红字**——直接跳 echo 步，
        // 那里有更稳定的入口；用户能继续走完整流程。
        console.warn('[onboarding/talk] init failed:', response.status);
        setStep('echo');
        return;
      }
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
        if (event.providerSwitch) setSwitchedHint(true);
        if (event.error) {
          // SSE 流中服务端 emit {error:'stream_failed'}——**不展示红字**；
          // 静默后等 readSse 自然走完，下方会跳 echo 步。
          console.warn('[onboarding/talk] sse event.error:', event.error);
        }
      });
      if (sid) setSessionId(sid);
    } catch (err) {
      // readSse 抛错（HTTP 非 2xx、网络中断）：**不展示红字**——跳 echo 步，
      // 让用户能继续走画像流程；console 留痕供诊断。
      console.warn('[onboarding/talk] stream catch:', err);
      setStep('echo');
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
      // silent 路径（echo 步"补充"消息）：**不展示红字**——静默入库即可。
      // 用户已经看到了 echo 内容，补充失败不影响主流程；console 留痕。
      // onboarding_talk 会话**复用** /api/chat/[sessionId]（kind=chat 才 401 的闸门让 onboarding_talk 放行）
      await fetch(`/api/chat/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, silent: true }),
      }).catch((err) => console.warn('[onboarding/silent] append failed:', err));
      return;
    }
    setStreaming(true);
    setSwitchedHint(false);
    try {
      // onboarding_talk 会话**复用** /api/chat/[sessionId]：
      // 服务端按 session.kind 分流，kind=onboarding_talk 走 respondToMessage 流程
      // （不能用 /api/onboarding/talk——那个接口每次新建会话、只发开场）
      const response = await fetch(`/api/chat/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!response.ok) {
        // 409 talk_limit_reached = 6 轮已满，温和收尾（不生硬跳 echo；流没走完也会在 finally 触发 talkFinished）
        // 其它非 2xx：兜底到 echo 步——**不展示红字**，产品口径。
        // 回滚刚才 optimistic 加进 turns 的 user 消息，避免 UI 留无 AI 回复的"卡住"残影。
        console.warn('[onboarding/chat] non-2xx:', response.status);
        setTurns((prev) => prev.slice(0, -1));
        if (response.status === 409 && reachedTalkLimit) {
          setTalkFinished(true);
        } else {
          void goEcho();
        }
        return;
      }
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
        if (event.providerSwitch) setSwitchedHint(true);
        if (event.error) {
          // SSE 流中服务端 emit error：**不展示红字**——静默后等 readSse 自然走完，
          // catch 兜底会跳 echo 步。
          console.warn('[onboarding/chat] sse event.error:', event.error);
        }
      });
    } catch (err) {
      // readSse 抛错：**不展示红字**——6 轮温和收尾 / 跳 echo 步走画像流程。
      console.warn('[onboarding/chat] sse catch:', err);
      setTurns((prev) => prev.slice(0, -1));
      if (reachedTalkLimit) {
        // 已聊满 6 轮但流挂了——按温和收尾（不跳 echo，避免再次触发 LLM）
        setTalkFinished(true);
      } else {
        void goEcho();
      }
    } finally {
      setStreaming(false);
      // 6 轮温和收尾：流结束且达到上限 → 显示主按钮"差不多了，去看看"
      // （覆盖流正常完成 + 6 轮已满两种场景；catch 路径走"未达上限则跳 echo"）
      if (reachedTalkLimit) setTalkFinished(true);
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
    } catch (err) {
      // 画像生成失败：**不展示红字**——回 reflect 步让用户重新确认 / 重试，
      // console 留痕。
      console.warn('[onboarding/portrait] generate failed:', err);
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
              {/* 多 provider 切换：仅在末条 assistant 下显示一次灰色小字 */}
              {i === turns.length - 1 && turn.role === 'assistant' && switchedHint && (
                <p className="mt-1 text-xs text-ink-soft">
                  {/* on/offboarding 暂时只有 zh-CN/en，i18n key 在 ChatView 走 dict.chat；这里硬编码中文作 fallback */}
                  （当前模型暂时不可用，已自动切换继续）
                </p>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        {/* 产品口径（2026-09-16）：不向用户展示任何红字错误。softHint 留作轻提示扩展位，当前未使用。 */}
        {softHint && <p className="mt-4 text-sm text-ink-soft">{softHint}</p>}
        {/* 6 轮温和收尾：禁输入 + 主按钮"差不多了，去看看"；未达到 6 轮时输入框可用 */}
        <TalkInput disabled={streaming || talkFinished} onSend={(text) => sendMessage(text)} />
        {talkFinished ? (
          <div className="mt-6 flex flex-col gap-2" data-talk-finished>
            <p className="text-sm text-ink-soft">{o.talk.doneHint}</p>
            <button
              type="button"
              onClick={goEcho}
              className="self-start rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90"
            >
              {o.talk.done} →
            </button>
          </div>
        ) : (
          userTurns >= 1 && !streaming && (
            <button
              type="button"
              onClick={goEcho}
              className="mt-6 self-start rounded-full border border-accent px-6 py-2 text-sm text-accent hover:bg-accent hover:text-paper"
            >
              {o.echo.title} →
            </button>
          )
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
        {/* 产品口径（2026-09-16）：不向用户展示任何红字错误。softHint 留作轻提示扩展位，当前未使用。 */}
        {softHint && <p className="mt-4 text-sm text-ink-soft">{softHint}</p>}
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
        {/* 产品口径（2026-09-16）：不向用户展示任何红字错误。softHint 留作轻提示扩展位，当前未使用。 */}
        {softHint && <p className="mt-4 text-sm text-ink-soft">{softHint}</p>}
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
