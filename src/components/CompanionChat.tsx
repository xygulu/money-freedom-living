'use client';

// 前台改造（70-2 C3）· 球点开后的弹层。
//
// 70-2 加固（A 项）：四件套标题/副文/气泡/页脚 + 四种模式：
//   - presence: 默认「我在这儿。」
//   - hint:     "有件事想问你"（nudge 命中时弹层首屏）
//   - hintToday: §6 唯一例外——"今天这一步你还没做"（球在 todayStepDone=false 且 nudge 命中时切）
//   - door:     收尾「想多说两句」
//
// MVP 不接 chat SSE；如要"球点开真能聊"，把 onSubmit 接到 /chat?start=1 跳页即可（保持单会话来源）。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';
import styles from './CompanionChat.module.css';

export type CompanionChatMode = 'presence' | 'hint' | 'hintToday' | 'door';

interface Props {
  onClose: () => void;
  /** nudge 文案（陪伴者刚才想说的话）；首次打开弹层时把它当首屏气泡（hint / hintToday） */
  dictNudge?: string | null;
  /** 弹层模式（默认 presence；Companion 根据 todayStepDone + nudge 命中算） */
  mode?: CompanionChatMode;
  dict: Dict;
}

export default function CompanionChat({
  onClose,
  dictNudge = null,
  mode = 'presence',
  dict,
}: Props) {
  const [draft, setDraft] = useState('');
  const t = dict.companion;
  const m = t.chatMode[mode];
  // hintToday 模式：用户保留的§6 唯一例外气泡，hintBubble.hintToday（固定拼出）
  const bubbleText = mode === 'hintToday' ? t.hintBubble.hintToday : dictNudge;

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-label={t.aria}>
      <div className={styles.panel} data-mode={mode}>
        <header className={styles.header}>
          <div className={styles.titleWrap}>
            <div className={styles.title}>{m.title}</div>
            <p className={styles.sub}>{m.sub}</p>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          {bubbleText ? (
            <div className={styles.bubbleCompanion}>{bubbleText}</div>
          ) : (
            <div className={styles.empty}>{t.chatEmpty}</div>
          )}
        </div>

        <footer className={styles.footer}>
          <input
            className={styles.input}
            type="text"
            placeholder={t.chatPlaceholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            className={styles.send}
            disabled={draft.trim().length === 0}
            onClick={() => {
              // MVP：不接 SSE；点"送出"会把用户带去完整 chat 页（autoStart）。
              // 跳转由 onClose + 触发事件承担，目前先单纯清空。
              setDraft('');
            }}
          >
            {t.chatSend}
          </button>
        </footer>

        <p className={styles.exitHint}>{m.foot}</p>
      </div>
    </div>
  );
}
