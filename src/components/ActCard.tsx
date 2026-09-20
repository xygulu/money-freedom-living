'use client';

// 前台改造（70-2 B2）· 今天这一步卡（新版一幕专用）。
//
// 70-2 加固（F/G/M 项）按原型重做：
// - act 段三选一：**做了 / 换一个 / 跳过**（不是"做了一半/今天没顾上"——那是 commitSheet Q1）
//   - 做了 → 弹 commitSheet（②我留意到 ③第一句话，可全留空）+ "今天到这里"
//   - 换一个 → 切 act 文本为 swapText；不弹 commitSheet
//   - 跳过 → 折叠 act 段成 skipNote；不弹 commitSheet
// - commitSheet 是与 chatSheet 同级的 sheet 弹层；MVP 内联在本组件里
// - 提交字段 did 是 done/partial/missed（与 /api/journey/close 契约兼容）
//
// 提交字段（仅"做了"路径）：
//   did: 'done' | 'partial' | 'missed'
//   thought: commitSheet ②
//   firstLine: commitSheet ③（用户首句；firstLineSkipped=true 表示留空）
//
// 2026-09-18 书写位（用户反馈："这里说写一条 xxx，但是用户在哪里写呢"）：
// 练习是"写下/试着改成…"这类动作，但卡片上只有 做了/换一个/跳过 三个按钮，
// 没有写的地方。现已在练习文本下常驻一个书写框——写完点「做了」，commitSheet ③
// 自动带入写的内容（可改），落库走既有 firstLine 通道（threads[].evidence 原话 +
// L5 分类 + 回执引用），/api/journey/close 契约零改动。产品由此拿到"真做了"的
// 行为证据（写了 = 灯有记录可依，M10 行为证据硬闸）。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';
import styles from './ActCard.module.css';

export type DidChoice = 'done' | 'partial' | 'missed';
export type ActPick = 'did' | 'swap' | 'skip';

export interface SubmittedPayload {
  did: DidChoice;
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
  const [pick, setPick] = useState<ActPick | null>(null);
  const [showCommit, setShowCommit] = useState(false);
  const [did, setDid] = useState<DidChoice | null>(null);
  const [thought, setThought] = useState('');
  const [firstLine, setFirstLine] = useState('');
  const [firstLineSkipped, setFirstLineSkipped] = useState(false);
  const [actWrite, setActWrite] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');

  const choices: { value: ActPick; label: string }[] = [
    { value: 'did', label: t.actChoices.did },
    { value: 'swap', label: t.actChoices.swap },
    { value: 'skip', label: t.actChoices.skip },
  ];

  function handlePick(p: ActPick) {
    if (state === 'saving') return;
    setPick(p);
    if (p === 'did') {
      setShowCommit(true);
      setDid(null);
      setThought('');
      // 书写位已写的内容带入 ③（可改可留空跳过）——用户在卡片上写的字不丢
      setFirstLine(actWrite.trim());
      setFirstLineSkipped(false);
    }
    // swap / skip 不弹 commitSheet —— ActCard 内文本/折叠各自处理
  }

  async function submitCommit() {
    if (!did || state !== 'idle') return;
    setState('saving');
    try {
      const res = await fetch('/api/journey/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          did,
          thought: thought.trim() || undefined,
          firstLine: firstLineSkipped ? undefined : firstLine.trim() || undefined,
          firstLineSkipped,
          locale,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { receipt?: string | null };
      const receipt = typeof data.receipt === 'string' && data.receipt ? data.receipt : null;
      onSubmitted({
        did,
        thought: thought.trim(),
        firstLine: firstLineSkipped ? '' : firstLine.trim(),
        firstLineSkipped,
        receipt,
      });
      setShowCommit(false);
    } catch {
      setState('error');
    }
  }

  // skip 折叠后只显示 skipNote
  if (pick === 'skip') {
    return (
      <article className={styles.card} data-act-state="skip">
        <p className={styles.eyebrow}>{t.actEyebrow}</p>
        <p className={styles.actNote}>{t.actSkipNote}</p>
        {/* 折叠后允许"改一下"回到三选一 */}
        <button
          type="button"
          onClick={() => setPick(null)}
          className={styles.editBtn}
        >
          ←
        </button>
      </article>
    );
  }

  // swap 后切 act 文本为 swapText + swapNote；仍允许换回去或选"做了"
  const actText = pick === 'swap' ? t.actSwapText : exercise;
  const actNote = pick === 'swap' ? t.actSwapNote : null;

  return (
    <>
      <article className={styles.card} data-act-state={pick ?? 'idle'}>
        <p className={styles.eyebrow}>{t.actEyebrow}</p>
        {actText ? (
          <p className={styles.exercise} data-exercise-text="">
            {actText}
          </p>
        ) : (
          <p className={styles.exerciseMuted}>今天没有练习——只看一眼也行。</p>
        )}
        {actNote && <p className={styles.actNote}>{actNote}</p>}

        {/* 书写位（2026-09-18）：练习若要写（写下一条"必须"…），写在这里。
            点「做了」时内容自动带入 commitSheet ③ 落证据；不写直接点也行。 */}
        <div className={styles.writeWrap}>
          <textarea
            value={actWrite}
            onChange={(e) => setActWrite(e.target.value)}
            maxLength={300}
            placeholder={t.actWritePlaceholder}
            className={styles.commitTextarea}
            data-act-write=""
            aria-label={t.actWritePlaceholder}
          />
        </div>

        <fieldset className={styles.choices}>
          <legend className={styles.srOnly}>{t.actEyebrow}</legend>
          {choices.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-pressed={pick === c.value}
              onClick={() => handlePick(c.value)}
              className={`${styles.choice} ${pick === c.value ? styles.choiceOn : ''}`}
              data-act-choice={c.value}
            >
              {c.label}
            </button>
          ))}
        </fieldset>
      </article>

      {/* commitSheet 弹层（仅 pick === 'did' 时挂） */}
      {showCommit && (
        <div className={styles.scrim} role="dialog" aria-modal="true" aria-label={t.commitEyebrow} data-commit-sheet>
          <div className={styles.sheet}>
            {/* 标题行：与陪伴者弹层同款——标题左（16px medium）、关闭钮右（24px），同行居中 + 分隔线 */}
            <div className={styles.sheetHead}>
              <p className={styles.sheetTitle}>{t.commitEyebrow}</p>
              <button
                type="button"
                className={styles.sheetClose}
                aria-label="关闭"
                onClick={() => {
                  setShowCommit(false);
                  setPick(null);
                }}
                data-commit-close
              >
                ×
              </button>
            </div>

            {/* 叙述顺序（2026-09-18 重排，用户反馈"1/2/3 的逻辑搞不懂"）：
                ① 做了吗 → ② 写下的那句（卡片书写框自动带入，连接可见）→ ③ 还想到什么。
                字段通道不变（thought / firstLine），只动 UI 顺序与标签。 */}
            {/* ① 我做了 */}
            <fieldset className={styles.commitGroup}>
              <legend className={styles.commitQ}>{t.commitQ1}</legend>
              <div className={styles.commitOpts}>
                {t.commitDidOptions.map((opt, i) => {
                  const v: DidChoice = (['done', 'partial', 'missed'] as const)[i] ?? 'done';
                  return (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={did === v}
                      onClick={() => setDid(v)}
                      className={`${styles.choice} ${did === v ? styles.choiceOn : ''}`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* ② 我写下的（= 卡片书写框带入的那句；跳过也行） */}
            <div className={styles.commitGroup}>
              <label htmlFor="commit-firstline" className={styles.commitQ}>
                {t.commitQ2}
              </label>
              <textarea
                id="commit-firstline"
                value={firstLine}
                onChange={(e) => {
                  setFirstLine(e.target.value);
                  if (firstLineSkipped) setFirstLineSkipped(false);
                }}
                maxLength={300}
                placeholder={t.commitQ2Placeholder}
                disabled={firstLineSkipped}
                className={styles.commitTextarea}
              />
              <div className={styles.commitRow}>
                <button
                  type="button"
                  onClick={() => {
                    setFirstLineSkipped((v) => !v);
                    if (!firstLineSkipped) setFirstLine('');
                  }}
                  className={styles.cantRecall}
                  data-cant-recall={firstLineSkipped}
                >
                  {firstLineSkipped ? '✓ ' : ''}{t.commitWrittenHint}
                </button>
              </div>
            </div>

            {/* ③ 我想到 */}
            <div className={styles.commitGroup}>
              <label htmlFor="commit-thought" className={styles.commitQ}>
                {t.commitQ3}
              </label>
              <textarea
                id="commit-thought"
                value={thought}
                onChange={(e) => setThought(e.target.value)}
                maxLength={300}
                placeholder={t.commitQ3Placeholder}
                className={styles.commitTextarea}
              />
            </div>

            <p className={styles.commitHint}>{t.commitAllEmptyHint}</p>

            <div className={styles.commitFooter}>
              <button
                type="button"
                onClick={submitCommit}
                disabled={!did || state === 'saving'}
                className={styles.submit}
                data-commit-submit
              >
                {state === 'saving' ? '…' : t.commitSubmit}
              </button>
            </div>
            {state === 'error' && <p className={styles.error}>这一格没交上。再试一次。</p>}
          </div>
        </div>
      )}
    </>
  );
}
