'use client';

// 前台改造（70-2 C3）· 门入口。
//
// 路下面"想多说两句"链接跳 `/chat?start=1&door=1[&quote=<urlencoded>]` 时，
// /chat 顶部显示这条小提示：
// - 有 quote：原样回放用户刚写的那句（让 AI 先开口时能引用）
// - 无 quote：展示 doorFallback（"今天到这里了。想说什么就说，我在。"）
//
// 为什么是 banner 而非接管 ChatView：
// ChatView 自己的 opener 机制已经会在新建会话时由 AI 先开口并接 memories，
// 本组件只是把"你刚说的话"摆到顶部让 AI / 用户都能看见，行为本身零侵入。
//
// ⚠️ quote 内容来自 URL，是用户在前一幕提交的原文——再次展示让他知道门接到了，
// 也是"AI 引用用户原话"承诺的兑现。
import { useSearchParams } from 'next/navigation';
import styles from './CompanionDoor.module.css';

interface Props {
  fallback: string;
}

export default function CompanionDoor({ fallback }: Props) {
  const params = useSearchParams();
  const door = params?.get('door');
  if (door !== '1') return null;

  const quote = params?.get('quote')?.trim() || '';
  const display = quote ? `你刚说的：${quote}` : fallback;

  return (
    <aside className={styles.banner} data-companion-door="" role="note">
      <span className={styles.dot} aria-hidden="true">·</span>
      <span className={styles.text}>{display}</span>
    </aside>
  );
}