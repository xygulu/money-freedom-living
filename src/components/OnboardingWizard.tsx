'use client';

// 体检向导（P0-3 首启重排 v2 · 2026-09-17）：
//   首页按钮 → /onboarding → 直接进 form 第一题（无 welcome 步、无中间页）
//   form → reflect（问卷答案本地复述 + 同意区）→ generating → echo（画像完成礼物）
//   echo 步三个 CTA：继续（进选书步）/ 想多聊聊（创建 session 进 talk）/ 保存（注册 nudge）
//   book 步（V0.2 A2 · 2026-09-21）：「你读完的是哪一本？」只列在册 active 书；
//   不在册 → 「我提到过这本书」记愿望（不许诺时间、不陈列、只回显一次）。
//   不设死闸（docs/02 §20.1）：不选书也能继续（「看画像」常亮）。
//   选完接选命题是批 B 的事——本批选完书照旧去 /portrait。
//
// 两条红线没动：
// - 顺序铁律（docs/05 §7）：先被说中 → 再注册 / 同意 / 定价。同意区仍在"被说中"**之后**。
// - 校验口径（2026-09-17）：4 道 choice 必选 + 至少 1 道 free-text 非空，否则后端 400 拒收；
//   `canSubmit` 在前端先把守，避免最后一题按钮无效点击。
//
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { QUESTIONS } from '@/lib/onboarding-questions';
import { readSse } from '@/lib/sse-client';
import type { Dict } from '@/i18n/get-dict';
import type { Locale } from '@/i18n/config';
import type { TopicId } from '@/lib/content'; // 仅类型，编译期擦除，不把 content.ts 拉进浏览器 chunk

interface Props {
  locale: Locale;
  dict: Dict;
  /** 在册 active 书（服务端按当前语言取好书名；V0.2 A2）。topics 随书带给选命题屏（B1） */
  books: { id: string; title: string; topics: TopicId[] }[];
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

type Step = 'form' | 'reflect' | 'generating' | 'echo' | 'book' | 'topic' | 'talk';

export default function OnboardingWizard({ locale, dict, books }: Props) {
  // 首启直接 form（设计决策 #6：welcome 步彻底删除）
  const [step, setStep] = useState<Step>('form');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  // 画像生成失败软提示（产品口径 2026-09-17）：不向用户显示服务端报错，失败置位后在
  // reflect 步显示 o.reflect.retryHint + "再试一次"按钮（直接调 generatePortrait）
  const [portraitFailed, setPortraitFailed] = useState(false);
  // 画像完成后的第一句话（echo 步）—— 由 /api/onboarding/reflect Path B 生成
  const [echo, setEcho] = useState('');
  const [echoFailed, setEchoFailed] = useState(false);
  const [echoLoading, setEchoLoading] = useState(false);
  const [echoLoaded, setEchoLoaded] = useState(false); // 防止 echo 步 useEffect 重复触发
  // 6 轮温和收尾（产品口径 2026-09-16）：chat 后置后仍适用（echo CTA 进 talk 后可能聊满 6 轮）
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
  // 任何服务端/网络异常都走"静默兜底"——console.warn 留痕，UI 不展示红字。
  const [softHint, setSoftHint] = useState<string | null>(null);
  // 多 provider 切换提示
  const [switchedHint, setSwitchedHint] = useState(false);
  // 选书步（V0.2 A2/A4）：选中的书 / 愿望入口展开 / 愿望已记（回显一次后不再出现）
  const [selectedBook, setSelectedBook] = useState<string | null>(null);
  // 选命题步（V0.2 B1）：选中的焦点命题（说不清 = 保持 null，与今天行为一致）
  const [selectedTopic, setSelectedTopic] = useState<TopicId | null>(null);
  const [wishOpen, setWishOpen] = useState(false);
  const [wishTitle, setWishTitle] = useState('');
  const [wishDone, setWishDone] = useState(false);
  const [bookBusy, setBookBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 首次"说中了"耗时的起点：进到这个页面的那一刻（指标见 docs/05 §7）。
  // 首启重排 v2 后起点仍是落地那一刻——问卷/复述/画像/echo 都算在这 3 分钟里
  const startedAtRef = useRef(Date.now());

  const o = dict.onboarding;
  const userTurns = turns.filter((t) => t.role === 'user').length;
  // 6 是与 src/lib/chat.ts:22 TALK_MAX_USER_MESSAGES 镜像的 UI 上限
  const reachedTalkLimit = userTurns >= 6;

  // 校验口径（设计决策 #4）：4 道 choice 必选 + 至少 1 道 free-text 非空
  const choiceFilled = QUESTIONS.every((q) => q.kind !== 'choice' || Boolean(answers[q.id]?.trim()));
  const freeTextFilled = QUESTIONS.filter((q) => q.kind === 'free').some((q) => answers[q.id]?.trim());
  const canSubmit = choiceFilled && freeTextFilled;

  function setAnswer(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  /** form 步最后一题触发：提交问卷答案进档 + 进 reflect 步。
   *  校验由 canSubmit 在前端先守；服务端再守一次（answers route 400）。 */
  async function submitAnswersAndReflect(): Promise<void> {
    if (!canSubmit) return;
    const answerable = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
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
      console.warn('[onboarding/answers] submit failed:', err);
      setSoftHint('网络不太顺，再点一次试试');
      return; // 失败停在 form 步，让他能再点
    } finally {
      setSavingForm(false);
    }
    setStep('reflect');
    void goReflect();
  }

  /** reflect 步准备：在新流程下不调 LLM——只标记 reflectDone 让同意区出现。
   *  echo 内容由 echo 步的 useEffect 单独拉（/api/onboarding/reflect Path B）。 */
  async function goReflect() {
    setReflectDone(true);
  }

  /** echo 步：拉"我从你刚填的里听到的一句话"（Path B：questionnaire 主素材） */
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
      setEchoLoaded(true);
    }
  }

  /** echo 步首次进入时自动拉取——避免空 echo 闪现 */
  useEffect(() => {
    if (step === 'echo' && !echoLoaded && !echoLoading) {
      void loadEcho();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function startTalk() {
    setStreaming(true);
    setSwitchedHint(false);
    try {
      const response = await fetch('/api/onboarding/talk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      if (!response.ok) {
        // 服务端初始化失败：跳 echo 步兜底
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
          console.warn('[onboarding/talk] sse event.error:', event.error);
        }
      });
      if (sid) setSessionId(sid);
    } catch (err) {
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
    const willReachLimit = userTurns + 1 >= 6;
    setTurns((prev) => [...prev, { role: 'user', content: text }]);
    if (silent) {
      // silent 路径（echo 步"补充"消息）：不展示红字；console 留痕
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
      const response = await fetch(`/api/chat/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!response.ok) {
        console.warn('[onboarding/chat] non-2xx:', response.status);
        setTurns((prev) => prev.slice(0, -1));
        if (response.status === 409 && willReachLimit) {
          setTalkFinished(true);
        } else {
          setStep('echo');
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
          console.warn('[onboarding/chat] sse event.error:', event.error);
        }
      });
    } catch (err) {
      console.warn('[onboarding/chat] sse catch:', err);
      setTurns((prev) => prev.slice(0, -1));
      if (reachedTalkLimit) {
        setTalkFinished(true);
      } else {
        setStep('echo');
      }
    } finally {
      setStreaming(false);
      if (reachedTalkLimit) setTalkFinished(true);
    }
  }

  async function generatePortrait() {
    if (!adultOk || !sensitiveOk) return;
    setStep('generating');
    setPortraitFailed(false);
    try {
      const response = await fetch('/api/onboarding/portrait', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale, sessionId, consent: true }),
      });
      if (!response.ok) throw new Error(String(response.status));
      if (touchOk) {
        await fetch('/api/touch/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ optIn: true }),
        }).catch(() => {});
      }
      // 画像成功 → echo 步（首启重排 v2：echo 作为画像完成礼物）
      setStep('echo');
    } catch (err) {
      console.warn('[onboarding/portrait] generate failed:', err);
      setStep('reflect');
      setPortraitFailed(true);
    }
  }

  /** 选书落库（V0.2 A3）。失败静默（产品口径：不展示红字），不拦「看画像」。 */
  async function selectBook(bookId: string) {
    if (bookBusy) return;
    setBookBusy(true);
    try {
      const response = await fetch('/api/me/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, locale, mode: 'select' }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setSelectedBook(bookId);
    } catch (err) {
      console.warn('[onboarding/book] select failed:', err);
    } finally {
      setBookBusy(false);
    }
  }

  /** 选命题（V0.2 B1）：焦点命题落到 books[].focusTopic（同一 /api/me/books 入口，
   *  埋点分开记 focus_topic_set）。失败静默——焦点是锦上添花，不拦看画像。 */
  async function selectTopic(topic: TopicId) {
    if (!selectedBook || bookBusy) return;
    setBookBusy(true);
    try {
      const response = await fetch('/api/me/books', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: selectedBook, focusTopic: topic, locale, mode: 'select' }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setSelectedTopic(topic);
    } catch (err) {
      console.warn('[onboarding/topic] focus failed:', err);
    } finally {
      setBookBusy(false);
    }
  }

  /** 记一条书愿望（V0.2 A4）。成功后回显一次「记下了」，输入框收起。失败静默。 */
  async function submitWish() {
    const title = wishTitle.trim();
    if (!title || bookBusy) return;
    setBookBusy(true);
    try {
      const response = await fetch('/api/me/wishes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, locale }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setWishDone(true);
      setWishOpen(false);
      setWishTitle('');
    } catch (err) {
      console.warn('[onboarding/book] wish failed:', err);
    } finally {
      setBookBusy(false);
    }
  }

  // ---------- 各步渲染 ----------

  // form 步：6 题拆成多段，一次一件
  if (step === 'form') {
    const q = QUESTIONS[qi];
    const qd = (o.questions as Record<string, { text: string; options?: Record<string, string>; placeholder?: string }>)[q.id];
    const last = qi === QUESTIONS.length - 1;
    const advance = () => (last ? void submitAnswersAndReflect() : setQi((n) => n + 1));
    // 最后一题：canSubmit 才允许提交；其他题：单题跳过允许
    const submitDisabled = last ? !canSubmit || savingForm : savingForm;
    const submitHint = last && !canSubmit ? o.form.choiceRequired : null;
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
        {softHint && <p className="mt-4 text-sm text-ink-soft">{softHint}</p>}
        <div className="mt-8 flex items-center gap-4">
          {q.kind !== 'choice' && (
            <button
              type="button"
              onClick={advance}
              disabled={submitDisabled}
              className="rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {o.form.next}
            </button>
          )}
          {last ? (
            <button
              type="button"
              onClick={advance}
              disabled={submitDisabled}
              title={submitHint ?? undefined}
              className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink disabled:opacity-40"
            >
              {o.form.skip}
            </button>
          ) : (
            <button
              type="button"
              onClick={advance}
              disabled={savingForm}
              className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink disabled:opacity-40"
            >
              {o.form.skip}
            </button>
          )}
        </div>
        {last && submitHint && (
          <p className="mt-3 text-xs text-ink-soft" data-form-required-hint>{submitHint}</p>
        )}
      </div>
    );
  }

  // reflect 步：问卷答案本地复述 + 同意区（无 LLM summary 调用——echo 步另拉）
  if (step === 'reflect') {
    const consentReady = adultOk && sensitiveOk;
    const buttonDisabled = !consentReady;
    return (
      <div className="flex flex-col pt-12" data-step="reflect">
        <h2 className="text-xl font-medium">{o.reflect.title}</h2>
        {/* 问卷答案本地复述：Object.entries(answers) 渲染——素材已是 LLM 输入，不需要再过一道 LLM */}
        <div className="mt-6 border border-line bg-white/60 p-5 text-sm leading-relaxed" data-reflect-answers>
          {QUESTIONS.map((q) => {
            const v = answers[q.id]?.trim();
            if (!v) return null;
            const qd = (o.questions as Record<string, { text: string; options?: Record<string, string> }>)[q.id];
            const display = q.kind === 'choice' && qd.options ? qd.options[v] ?? v : v;
            return (
              <div key={q.id} className="mb-3 last:mb-0">
                <p className="mb-1 text-xs text-ink-soft">{qd.text}</p>
                <p>{display}</p>
              </div>
            );
          })}
        </div>
        <div className="mt-8 flex flex-col gap-3">
          {reflectDone && (
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
          {reflectDone && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={generatePortrait}
                disabled={buttonDisabled}
                className="self-start rounded-full bg-accent px-6 py-2 text-sm text-paper hover:opacity-90 disabled:opacity-40"
              >
                {o.reflect.confirm} · {o.reflect.next}
              </button>
              {!consentReady && (
                <p className="text-xs text-ink-soft">{o.reflect.disabledHint}</p>
              )}
              {portraitFailed && (
                <div className="mt-2 flex items-center gap-3" data-portrait-retry>
                  <p className="text-sm text-ink-soft">{o.reflect.retryHint}</p>
                  <button
                    type="button"
                    onClick={generatePortrait}
                    disabled={!adultOk || !sensitiveOk}
                    className="rounded-full border border-accent px-4 py-1.5 text-sm text-accent hover:bg-accent hover:text-paper disabled:opacity-40"
                  >
                    {o.reflect.retry}
                  </button>
                </div>
              )}
            </div>
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

  // echo 步：画像完成礼物——一句"我听到的是" + 三个 CTA（看画像 / 多聊聊 / 保存）
  if (step === 'echo') {
    return (
      <div className="flex flex-col pt-12" data-step="echo">
        <h2 className="text-xl font-medium">{o.echo.title}</h2>
        {echo && (
          <div data-echo className="mt-6 whitespace-pre-wrap border border-line bg-white/60 p-5 text-base leading-loose">
            {echo}
          </div>
        )}
        {!echo && !echoFailed && (echoLoading || !echoLoaded) && <p className="mt-6 animate-pulse text-sm text-ink-soft">{o.echo.loading}</p>}
        {echoFailed && <p className="mt-6 text-sm text-ink-soft">{o.echo.fallback}</p>}
        {(echo || echoFailed) && (
          <>
            <p className="mt-6 text-sm leading-relaxed text-ink-soft">{o.echo.hint}</p>
            {/* 主 CTA：继续 → 选书步（V0.2 A2：选书在 echo 之后；选完才见画像） */}
            <button
              type="button"
              onClick={() => setStep('book')}
              className="mt-8 inline-block self-start rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90"
            >
              {o.echo.next} →
            </button>
            {/* 次 CTA：想多聊聊（创建 onboarding_talk session，进 talk 步） */}
            <button
              type="button"
              onClick={goTalk}
              className="mt-3 self-start rounded-full border border-accent px-6 py-2 text-sm text-accent hover:bg-accent hover:text-paper"
            >
              {o.echo.chatCTA}
            </button>
            {/* 次 CTA：保存你的画像（注册 nudge：跳登录页，next 让登录后回 /portrait） */}
            <Link
              href={`/${locale}/login?next=${encodeURIComponent(`/${locale}/portrait`)}`}
              className="mt-3 self-start text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
            >
              {o.echo.saveCTA}
            </Link>
            {/* P1-6/P1-7（2026-11-13）：在被说中的峰值时刻才说这句话——价值讲成
                「关系延续」（你走了之后我还能找到你），不是「数据归属」（档案跟着账号走）。
                游客丢上下文零提示的缺口也在这一行补上：放在 echo（画像刚说完他），
                不放在流程结尾的例行公事位置。 */}
            <p data-echo-keep-line className="mt-2 text-xs leading-relaxed text-ink-soft/70">
              {o.echo.keepLine}
            </p>
          </>
        )}
      </div>
    );
  }

  // book 步（V0.2 A2）：「你读完的是哪一本？」——只列在册 active 书；不在册走愿望入口。
  // 不设死闸：不选也能继续（主 CTA 常亮）。愿望只回显一次，不做书单陈列（docs/02 §20.1 A4）。
  if (step === 'book') {
    return (
      <div className="flex flex-col pt-12" data-step="book">
        <h2 className="text-xl font-medium">{o.book.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{o.book.hint}</p>
        <div className="mt-6 flex flex-col gap-2">
          {books.map((b) => {
            const selected = selectedBook === b.id;
            return (
              <button
                key={b.id}
                type="button"
                data-book-option={b.id}
                aria-pressed={selected}
                disabled={bookBusy}
                onClick={() => selectBook(b.id)}
                className={`rounded border px-4 py-3 text-left text-sm leading-relaxed transition-colors ${
                  selected ? 'border-accent bg-accent/10 text-ink' : 'border-line bg-white/60 text-ink-soft hover:text-ink'
                }`}
              >
                {b.title}
                {selected && <span className="ml-2 text-xs text-accent">{o.book.selected}</span>}
              </button>
            );
          })}
        </div>
        {/* 不在册 → 愿望入口（同屏；记一条就回显一次，没有书单页） */}
        <div className="mt-6" data-book-wish>
          {wishDone ? (
            <p className="text-sm leading-relaxed text-ink-soft" data-wish-reply>{o.book.wishReply}</p>
          ) : wishOpen ? (
            <div className="flex gap-2">
              <input
                value={wishTitle}
                onChange={(e) => setWishTitle(e.target.value)}
                placeholder={o.book.minePlaceholder}
                maxLength={100}
                className="flex-1 rounded border border-line bg-white/60 p-3 text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                disabled={!wishTitle.trim() || bookBusy}
                onClick={submitWish}
                className="rounded border border-line px-4 text-sm text-ink-soft hover:text-ink disabled:opacity-40"
              >
                {o.book.mineSubmit}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setWishOpen(true)}
              className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
            >
              {o.book.mine}
            </button>
          )}
        </div>
        {softHint && <p className="mt-4 text-sm text-ink-soft">{softHint}</p>}
        {/* 主 CTA：看画像——不设死闸，没选书也照常走；选了书先过选命题
            （V0.2 B1 定案「选完接选命题」，书没给命题选项时直接去画像） */}
        {selectedBook && (books.find((b) => b.id === selectedBook)?.topics.length ?? 0) > 0 ? (
          <button
            type="button"
            onClick={() => setStep('topic')}
            className="mt-8 inline-block self-start rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90"
          >
            {o.book.next} →
          </button>
        ) : (
          <Link
            href={`/${locale}/portrait`}
            className="mt-8 inline-block self-start rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90"
          >
            {o.book.next} →
          </Link>
        )}
      </div>
    );
  }

  // topic 步（V0.2 B1）：「读完它，你最想先弄明白哪一件事？」——选项来自本书 topics，
  // 命题名用 dict.topics 的用户文案（TOPICS_ZH 是 prompt 内部备注，不当作用户文案）。
  // 「说不清」＝不设焦点、直接去画像，与没选命题的今天完全一致；不设死闸，「看画像」常亮。
  if (step === 'topic' && selectedBook) {
    const topics = books.find((b) => b.id === selectedBook)?.topics ?? [];
    const topicName = (t: string) => (dict.topics as unknown as Record<string, string>)[t] ?? t;
    return (
      <div className="flex flex-col pt-12" data-step="topic">
        <h2 className="text-xl font-medium">{o.topic.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{o.topic.hint}</p>
        <div className="mt-6 flex flex-col gap-2">
          {topics.map((t) => {
            const selected = selectedTopic === t;
            return (
              <button
                key={t}
                type="button"
                data-topic-option={t}
                aria-pressed={selected}
                disabled={bookBusy}
                onClick={() => void selectTopic(t)}
                className={`rounded border px-4 py-3 text-left text-sm leading-relaxed transition-colors ${
                  selected ? 'border-accent bg-accent/10 text-ink' : 'border-line bg-white/60 text-ink-soft hover:text-ink'
                }`}
              >
                {topicName(t)}
              </button>
            );
          })}
        </div>
        {softHint && <p className="mt-4 text-sm text-ink-soft">{softHint}</p>}
        {/* 说不清 = 不设焦点（不发请求），与今天线上行为完全一致 */}
        <Link
          href={`/${locale}/portrait`}
          data-topic-option="none"
          className="mt-6 self-start text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
        >
          {o.topic.none}
        </Link>
        {/* 主 CTA：看画像——常亮，选不选命题都能走 */}
        <Link
          href={`/${locale}/portrait`}
          className="mt-8 inline-block self-start rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90"
        >
          {o.book.next} →
        </Link>
      </div>
    );
  }

  // talk 步：echo CTA 触发的深度对话（chat 后置）—— 6 轮温和收尾逻辑保留
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
            {i === turns.length - 1 && turn.role === 'assistant' && switchedHint && (
              <p className="mt-1 text-xs text-ink-soft">（当前模型暂时不可用，已自动切换继续）</p>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {softHint && <p className="mt-4 text-sm text-ink-soft">{softHint}</p>}
      <TalkInput disabled={streaming || talkFinished} onSend={(text) => sendMessage(text)} />
      {talkFinished ? (
        <div className="mt-6 flex flex-col gap-2" data-talk-finished>
          <p className="text-sm text-ink-soft">{o.talk.doneHint}</p>
          <button
            type="button"
            onClick={() => setStep('book')}
            className="self-start rounded-full bg-accent px-8 py-3 text-base text-paper transition-opacity hover:opacity-90"
          >
            {o.talk.done} →
          </button>
        </div>
      ) : (
        userTurns >= 1 && !streaming && (
          <button
            type="button"
            onClick={() => setStep('echo')}
            className="mt-6 self-start rounded-full border border-accent px-6 py-2 text-sm text-accent hover:bg-accent hover:text-paper"
          >
            {o.echo.title} →
          </button>
        )
      )}
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
