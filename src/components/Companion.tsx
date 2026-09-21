'use client';

// 前台改造（70-2 C1）· 陪伴者：右下角常驻，三态（静/晃/开）。
//
// - 位置：54×54，right:calc(50% - 195px + 20px); bottom:24px;（<420px → right:20px）
// - 三态：
//   静 = 默认（box-shadow 三层 + accent glow）
//   晃 = nudge 触发（1.2s ease-in-out × 2，不重复）
//   开 = 点开后弹层（CompanionChat）
// - 2026-09-18 行为调整（docs/03 §11）：陪伴者气泡点开**优先**导航到
//   /chat?start=1&door=1&quote=<urlencoded nudge.text>——把"想说的那句话"接进
//   对话里（用户原话："点击了之后这句话就看不见了…能不能放到对话里"）。
//   fallback 文案（source==='fallback'）走老路径：弹 CompanionChat 弹层。
// - nudge：mount 后安静 8 秒（O5′ 动效限量）才 fetch /api/companion/nudge 一次，
//   命中即触发晃 + 写 seen cookie
//   频次闸：24h 内不重（cookie `mfl_nudge_seen`，document.cookie 写读）= 每日至多一晃
// - 递归防呆：/chat 路由内 display:none（layout 端 + 本组件 usePathname 双保险）
//
// 70-2 加固（A/K/L 项）：
// - SVG 双 path 改为原型 §5 已定形（"人"肩到头 + 上半圆线）；不再是 circle+path 占位。
// - 加 <span className="pulse"> 元素（呼吸圈），box-shadow 三层顺序照原型 line 99-112。
// - 接收 todayStepDone：true 且 nudge 命中时，弹层切 hintToday 模式（§6 唯一例外）。
import { useEffect, useState, useRef, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import CompanionChat, { type CompanionChatMode } from '@/components/CompanionChat';
import type { Dict } from '@/i18n/get-dict';
import styles from './Companion.module.css';

const NUDGE_SEEN_COOKIE = 'mfl_nudge_seen';
// 弹层历史不再走 localStorage 缓存（2026-09-18 撤销）：缓存让重开弹窗看到旧数据、
// 缺刚聊的内容（用户反馈）。弹层自己每次打开拉 /api/chat/recent，正确性优先。

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
  const router = useRouter();

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
    // 24h 闸：今天已经看过 → 不再 fetch（即每日上限：真 nudge 命中就落 seen，一天至多一晃）
    if (readNudgeSeen()) return;
    // O5′ 球动效限量（docs/02 §19.2）：进页面先安静 8 秒——第一屏是用户自己的，
    // 球的招呼只在用户停留时才出现。取 nudge 与晃一起延到 8s。
    const timer = window.setTimeout(() => {
      if (animationDone.current) return;
      animationDone.current = true;
      void fetchNudge();
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [fetchNudge]);

  // §6 例外文案触发：今天这一步没做 + nudge 命中 + 用户点开球 → hintToday
  const chatMode: CompanionChatMode =
    !todayStepDone && nudge && nudge.source !== 'fallback' ? 'hintToday' : 'presence';

  // 2026-09-18 留痕（docs/03 §11）：陪伴者气泡点击改成导航到 /chat?start=1&door=1&quote=<nudge>。
  // 用户原话："点击了之后这句话就看不见了，能不能放到对话里，不然用户想要再看到它就不可能了"。
  // - ?start=1 让 ChatView 落地即开聊（不要求第二次点击）
  // - ?door=1 让 /chat 顶部显示 CompanionDoor banner（"你刚说的：…"，或 fallback 文案）
  // - ?quote=<urlencoded nudge.text> 同时落到对话历史里 + 给 AI opener 做素材。
  // 落地后 bubble 消失是合理的——用户已经接到这句话并进了对话；24h cookie 闸保留，
  // 避免回 /journey-new 又立刻被晃回去再次点。
  const hasQuote = Boolean(nudge && nudge.text && nudge.text.trim().length > 0);
  const handleBallClick = useCallback(() => {
    if (hasQuote) {
      const locale = pathname.split('/')[1] || 'zh-CN';
      const url = `/${locale}/chat?start=1&door=1&quote=${encodeURIComponent(nudge!.text)}`;
      router.push(url);
      return;
    }
    setOpen((v) => !v);
  }, [hasQuote, nudge, pathname, router]);

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
          onClick={handleBallClick}
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
          locale={pathname.split('/')[1] || 'zh-CN'}
          dictNudge={nudge?.text ?? null}
          mode={chatMode}
          dict={dict}
        />
      )}
    </>
  );
}
