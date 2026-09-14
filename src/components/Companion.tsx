'use client';

// 前台改造（70-2 C1）· 陪伴者：右下角常驻，三态（静/晃/开）。
//
// - 位置：54×54，right:calc(50% - 195px + 20px); bottom:24px;（<420px → right:20px）
// - 三态：
//   静 = 默认（box-shadow 三层 + accent glow）
//   晃 = nudge 触发（1.2s ease-in-out × 2，不重复）
//   开 = 点开后弹层（CompanionChat）
// - nudge：组件 mount 时 fetch /api/companion/nudge 一次，命中即触发晃 + 写 seen cookie
//   频次闸：24h 内不重（cookie `mfl_nudge_seen`，document.cookie 写读）
// - 递归防呆：/chat 路由内 display:none（layout 端 + 本组件 usePathname 双保险）
import { useEffect, useState, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import CompanionChat from '@/components/CompanionChat';
import styles from './Companion.module.css';

const NUDGE_SEEN_COOKIE = 'mfl_nudge_seen';

function readNudgeSeen(): boolean {
  if (typeof document === 'undefined') return false;
  const m = document.cookie.match(/(?:^|; )mfl_nudge_seen=([^;]*)/);
  return Boolean(m && m[1]);
}

function writeNudgeSeen(): void {
  if (typeof document === 'undefined') return;
  // 24h；SameSite=Lax；不 HttpOnly（前端读）
  const oneDay = 24 * 60 * 60;
  document.cookie = `${NUDGE_SEEN_COOKIE}=${Date.now()}; path=/; max-age=${oneDay}; samesite=lax`;
}

interface NudgePayload {
  text: string;
  source: string;
  hitRedLine: boolean;
}

export default function Companion() {
  const pathname = usePathname() ?? '';

  // 递归防呆：chat 路由内不挂载（CompanionChat 走自己的状态）
  const inChatRoute = pathname.endsWith('/chat') || pathname.includes('/chat/');
  if (inChatRoute) return null;

  const [open, setOpen] = useState(false);
  const [nudging, setNudging] = useState(false);
  const [nudge, setNudge] = useState<NudgePayload | null>(null);
  const animationDone = useRef(false);

  // mount 时取一次 nudge；命中 → 晃一次 + 落 seen cookie
  const fetchNudge = useCallback(async () => {
    try {
      const response = await fetch('/api/companion/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) return;
      const data = (await response.json()) as NudgePayload;
      if (!data || typeof data.text !== 'string') return;
      setNudge(data);
      // fallback 文案不算"被看见"（24h 闸只在真有内容时记录）
      if (data.source !== 'fallback') {
        writeNudgeSeen();
        setNudging(true);
        // 动画播完后清掉 nudged 标记；不开防连点（一次性）
        window.setTimeout(() => setNudging(false), 2600);
      }
    } catch {
      // 网络抖动：nudge 失败不影响陪伴者其他状态
    }
  }, []);

  useEffect(() => {
    // 24h 闸：今天已经看过 → 不再 fetch
    if (readNudgeSeen()) return;
    // 给服务端 hydrate + 直访用户 100ms 缓冲再请求（避免首屏抖动）
    const timer = window.setTimeout(() => {
      if (animationDone.current) return;
      animationDone.current = true;
      void fetchNudge();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [fetchNudge]);

  return (
    <>
      <div
        className={styles.wrap}
        data-companion=""
        data-nudge-state={nudging ? 'nudge' : open ? 'open' : 'idle'}
        aria-live="polite"
      >
        {nudge && !open && (
          <div className={styles.bubble} role="status">
            {nudge.text}
          </div>
        )}
        <button
          type="button"
          className={styles.ball}
          aria-label="陪伴者"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 36 36" width="22" height="22" aria-hidden="true">
            {/* "人" 双 path：原型 §5 用户已定形 */}
            <circle cx="18" cy="9" r="4" fill="currentColor" />
            <path
              d="M6 30 C 8 22, 12 18, 18 18 C 24 18, 28 22, 30 30"
              stroke="currentColor"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {open && (
        <CompanionChat onClose={() => setOpen(false)} dictNudge={nudge?.text ?? null} />
      )}
    </>
  );
}