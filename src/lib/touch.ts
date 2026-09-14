// 触达层（M11-E，docs/05 §9）：邮件是**节点召回**，不是日活引擎。
//
// 三条铁律，代码层面各有对应：
// 1. 不能天天发 —— 节点是固定的几天（D3/D7/D14/D21/D30/D66/D90），每个节点一辈子
//    只发一次（`claimTouchNode` 原子占位），且两封之间强制留 `MIN_GAP_DAYS` 天。
// 2. 必须 opt-in + 可退订 —— `pickTouchNode` 第一行就是 emailOptIn 闸；每封信都带
//    退订链接（`unsubUrl`），没有 token 就不发（宁可漏发，不可发出一封退不掉的信）。
// 3. 句式受限 —— 只允许「它记得你说过 X」，禁止「你还没做 / 你 3 天没来」。禁语在
//    `src/tests/touch.test.ts` 里逐条钉死，四语模板都过一遍。
//
// 为什么写成「信」而不是推送文案：产品的原生仪式本来就是信（给钱的一封信 / 给未来
// 自己的信），召回也用同一个形态——「三个月前，你写过一封信。它还在。」（§9.2）
import type { Dict } from '@/i18n/get-dict';
import type { GrowthProfile } from './profile';

/** 触达节点：从档案建立那天起算的第 N 天。顺序即优先级（先到先发）。 */
export const TOUCH_NODES = [3, 7, 14, 21, 30, 66, 90] as const;
export type TouchNode = `D${(typeof TOUCH_NODES)[number]}`;

/** 两封信之间至少隔这么多天——节点撞在一起时也不会连着轰 */
export const MIN_GAP_DAYS = 5;
/** 今天还活跃的人不需要召回（他人就在这儿） */
export const AWAY_DAYS = 2;

const DAY = 86_400_000;

function daysBetween(fromISO: string, now: Date): number {
  const t = Date.parse(fromISO);
  if (Number.isNaN(t)) return -1;
  return Math.floor((now.getTime() - t) / DAY);
}

function daysSinceDate(date: string | null, now: Date): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - t) / DAY);
}

/**
 * 该给这个人发哪个节点的信——发不得就返回 null。
 * 顺序是有意的：opt-in → 还在活跃 → 刚发过 → 到没到节点 → 发过没有。
 * 每一道都是「不发」的理由，最后才轮到「发」。
 */
export function pickTouchNode(profile: GrowthProfile, now: Date = new Date()): TouchNode | null {
  const touch = profile.touch ?? {};
  if (touch.emailOptIn !== true) return null; // 没同意收信 —— 一封都不发
  if (!touch.unsubToken) return null; // 退不掉的信不发
  if (daysSinceDate(profile.last_active_date, now) < AWAY_DAYS) return null; // 人就在这儿
  if (touch.lastSentAt && daysBetween(touch.lastSentAt, now) < MIN_GAP_DAYS) return null; // 刚发过

  const age = daysBetween(profile.created_at, now);
  if (age < 0) return null;
  const sent = touch.sentNodes ?? {};
  // 发过的最远的那个节点——比它更早的节点就此翻篇
  const passed = TOUCH_NODES.filter((n) => sent[`D${n}` as TouchNode]).reduce((a, b) => Math.max(a, b), 0);
  // 已经到期、还没发过的节点里挑**最大**的那个：中途才打开来信的人（比如第 40 天才
  // 勾上），先收到 D30 就够了，不该在之后几周里再被补发 D21 / D14 / D7 一串旧信。
  let hit: TouchNode | null = null;
  for (const n of TOUCH_NODES) {
    if (n <= passed) continue; // 只往前走，不回头补
    const node = `D${n}` as TouchNode;
    if (age >= n && !sent[node]) hit = node;
  }
  return hit;
}

/** 这封信引用的那句话：优先用他自己写过的信，其次是命题线上的原话，都没有就不引用 */
export function pickEcho(profile: GrowthProfile): { text: string; from: 'letter' | 'thread' } | null {
  const letters = profile.letters ?? [];
  for (let i = letters.length - 1; i >= 0; i--) {
    const text = (letters[i]?.content ?? '').trim();
    if (text) return { text, from: 'letter' };
  }
  const quotes = Object.values(profile.threads ?? {})
    .flatMap((t) => t?.evidence ?? [])
    .filter((e) => (e.quote ?? '').trim());
  const last = quotes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).pop();
  return last ? { text: last.quote.trim(), from: 'thread' } : null;
}

export function unsubUrl(baseUrl: string, locale: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/touch/unsubscribe?token=${encodeURIComponent(token)}&locale=${encodeURIComponent(locale)}`;
}

function clip(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export interface TouchLetter {
  subject: string;
  text: string;
  html: string;
}

/**
 * 组装一封信。模板全在 dict.touch.letters 里（四语），这里只做三件事：
 * 填上他自己的那句话、接上回来的路、挂上退订链接。
 * 注意：**不带任何进度/天数/未完成计数**——「你已经 N 天没来」是禁语（§9.4）。
 */
export function composeTouch(params: {
  node: TouchNode;
  profile: GrowthProfile;
  dict: Dict;
  locale: string;
  baseUrl: string;
}): TouchLetter | null {
  const { node, profile, dict, locale, baseUrl } = params;
  const token = profile.touch?.unsubToken;
  if (!token) return null;

  const t = dict.touch;
  const tpl = (t.letters as unknown as Record<string, { subject: string; body: string } | undefined>)[node];
  if (!tpl) return null;

  const echo = pickEcho(profile);
  // 有原话就引用他自己的话；没有（还没写过什么）就走不引用的那版，绝不编一句替他说
  const body = echo
    ? tpl.body.replace('{echo}', clip(echo.text))
    : t.bodyNoEcho.replace('{title}', dict.nav.journey);

  const back = `${baseUrl.replace(/\/$/, '')}/${locale}/journey`;
  const unsub = unsubUrl(baseUrl, locale, token);
  const text = [body, '', `${t.backLabel}: ${back}`, '', `${t.unsubLead} ${unsub}`].join('\n');
  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,sans-serif;font-size:15px;line-height:1.9;color:#2b2724;max-width:520px">`,
    ...body.split('\n').map((line) => `<p style="margin:0 0 14px">${escapeHtml(line)}</p>`),
    `<p style="margin:26px 0 0"><a href="${escapeHtml(back)}" style="color:#a4553c">${escapeHtml(t.backLabel)}</a></p>`,
    `<p style="margin:30px 0 0;font-size:12px;color:#9b938c">${escapeHtml(t.unsubLead)} <a href="${escapeHtml(unsub)}" style="color:#9b938c">${escapeHtml(t.unsubLabel)}</a></p>`,
    `</div>`,
  ].join('');
  return { subject: tpl.subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 触达通道有没有配好——没配不是错误，是"这台机器不发信"，调度器据此优雅降级 */
export function touchConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}
