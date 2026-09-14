'use client';

// 前台改造（70-2 C3）· 球点开后的弹层。
//
// - 标题"我在这儿。"
// - 三点菜单（占位）
// - 输入框（视觉，MVP 不接 chat SSE；接则复用 ChatView 路径）
// - 空状态文案：dict.companion.chatEmpty
// - AI 静默开场：没有自动 opener，按用户节奏来
//
// 后续若要"球点开真能聊"：把 onSubmit 接到 /chat?start=1 跳页即可（保持单会话来源）。
import { useState } from 'react';
import styles from './CompanionChat.module.css';

interface Props {
  onClose: () => void;
  /** nudge 文案（陪伴者刚才想说的话）；首次打开弹层时把它当首屏气泡 */
  dictNudge?: string | null;
}

export default function CompanionChat({ onClose, dictNudge = null }: Props) {
  const [draft, setDraft] = useState('');

  return (
    <div className={styles.scrim} role="dialog" aria-modal="true" aria-label="陪伴者">
      <div className={styles.panel}>
        <header className={styles.header}>
          <div className={styles.title}>我在这儿。</div>
          <button
            type="button"
            className={styles.dots}
            aria-label="更多"
            tabIndex={-1}
            onClick={(e) => {
              // 三点菜单占位：MVP 暂不接动作
              e.preventDefault();
            }}
          >
            ⋯
          </button>
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
          {dictNudge ? (
            <div className={styles.bubbleCompanion}>{dictNudge}</div>
          ) : (
            <div className={styles.empty}>
              陪伴者打开了。慢慢来，不一定非得说什么。
            </div>
          )}
        </div>

        <footer className={styles.footer}>
          <input
            className={styles.input}
            type="text"
            placeholder="想說就說……"
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
            送出
          </button>
        </footer>

        <p className={styles.exitHint}>今天不聊也行。</p>
      </div>
    </div>
  );
}