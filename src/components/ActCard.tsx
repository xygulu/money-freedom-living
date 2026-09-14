'use client';

// 前台改造（70-2 B2）· 今天这一步提交卡（新版一幕专用）。
//
// 与经典版 DayCloseCard 行为同源（同 API /api/journey/close），但本组件：
// - 提交后通过 onSubmitted 把数据交给 NewJourneyView（mirror 段需要）
// - 顶部带"今天这一步"小标 + 一条微行动提议（pickExercise 结果）
// - 三选一按钮 + 一句 thought 输入（不上 firstLine/cantRecall，简化给一幕）
//
// 提交字段：
//   did: 'done' | 'partial' | 'missed'
//   thought: 选填
//   firstLine/cantRecall: 暂不收（一幕更轻；评估深度保留给经典版 DayCloseCard）
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';
import styles from './ActCard.module.css';

type Did = 'done' | 'partial' | 'missed';

interface SubmittedPayload {
  did: Did;
  thought: string;
  firstLine: string;
  firstLineSkipped: boolean;
  receipt: string | null;
}

interface Props {
  locale: string;
  dict: Dict;
  exercise: string | null;
  onSubmitted: (payload: SubmittedPayload) => void;
}

export default function ActCard({ locale, dict, exercise, onSubmitted }: Props) {
  const t = dict.newJourney;
  const [did, setDid] = useState<Did | null>(null);
  const [thought, setThought] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');

  const choices: { value: Did; label: string }[] = [
    { value: 'done', label: t.actChoices.done },
    { value: 'partial', label: t.actChoices.partial },
    { value: 'missed', label: t.actChoices.missed },
  ];

  async function submit() {
    if (!did || state !== 'idle') return;
    setState('saving');
    try {
      const res = await fetch('/api/journey/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          did,
          thought: thought.trim() || undefined,
          firstLineSkipped: true,
          locale,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { receipt?: string | null };
      const receipt = typeof data.receipt === 'string' && data.receipt ? data.receipt : null;
      onSubmitted({ did, thought: thought.trim(), firstLine: '', firstLineSkipped: true, receipt });
    } catch {
      setState('error');
    }
  }

  return (
    <article className={styles.card}>
      <p className={styles.eyebrow}>{t.actEyebrow}</p>
      {exercise ? (
        <p className={styles.exercise} data-exercise-text="">
          {exercise}
        </p>
      ) : (
        <p className={styles.exerciseMuted}>今天没有练习——只看一眼也行。</p>
      )}

      <fieldset className={styles.choices}>
        <legend className={styles.srOnly}>{t.actEyebrow}</legend>
        {choices.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={did === c.value}
            onClick={() => setDid(c.value)}
            className={`${styles.choice} ${did === c.value ? styles.choiceOn : ''}`}
          >
            {c.label}
          </button>
        ))}
      </fieldset>

      <label className={styles.thoughtLabel} htmlFor="act-thought">
        一句话（可选）
      </label>
      <input
        id="act-thought"
        type="text"
        maxLength={200}
        value={thought}
        onChange={(e) => setThought(e.target.value)}
        placeholder="想到了什么就写一句……"
        className={styles.thoughtInput}
      />

      <button
        type="button"
        onClick={submit}
        disabled={!did || state === 'saving'}
        className={styles.submit}
      >
        {state === 'saving' ? '…' : t.actDoneCta}
      </button>

      {state === 'error' && (
        <p className={styles.error}>这一格没交上。再试一次。</p>
      )}
    </article>
  );
}