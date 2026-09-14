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
//
// 70-2 加固（A/K/L 项）：
// - SVG 双 path 改为原型 §5 已定形（"人"肩到头 + 上半圆线）；不再是 circle+path 占位。
// - 加 <span className="pulse"> 元素（呼吸圈），box-shadow 三层顺序照原型 line 99-112。
// - 接收 todayStepDone：true 且 nudge 命中时，弹层切 hintToday 模式（§6 唯一例外）。
import { useEffect, useState, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import CompanionChat, { type CompanionChatMode } from '@/components/CompanionChat';
import type { Dict } from '@/i18n/get-dict';
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

interface Props {
  /** 今天这一步做没做。true 且 nudge 命中 → 弹层切 hintToday 模式（§6 例外文案） */
  todayStepDone?: boolean;
  /** 字典（用于弹层四件套：title/sub/bubble/foot） */
  dict: Dict;
}

export default function Companion({ todayStepDone = false, dict }: Props) {
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

  // §6 例外文案触发：今天这一步没做 + nudge 命中 + 用户点开球 → hintToday
  const chatMode: CompanionChatMode =
    !todayStepDone && nudge && nudge.source !== 'fallback' ? 'hintToday' : 'presence';

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
          aria-label={dict.companion.aria}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {/* 呼吸圈：breathe 动画，layer 在 SVG 下 */}
          <span className={styles.pulse} aria-hidden="true" />
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            {/* 原型 §5 用户定形的「人」双 path：
                肩到头 + 上半圆线。原型 v1 line 409-411 */}
            <path
              d="M12 4.6c-2.6 0-4.6 2-4.6 4.6 0 3.6 3 5.1 3 7.9 0 1.4-.7 2.3-.7 2.3h4.6s-.7-.9-.7-2.3c0-2.8 3-4.3 3-7.9 0-2.6-2-4.6-4.6-4.6z"
              fill="currentColor"
            />
            <path
              d="M9.6 4.2c.6-.9 1.5-1.4 2.4-1.4s1.8.5 2.4 1.4"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
      </div>

      {open && (
        <CompanionChat
          onClose={() => setOpen(false)}
          dictNudge={nudge?.text ?? null}
          mode={chatMode}
          dict={dict}
        />
      )}
    </>
  );
}
