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

/** 两封信之间至少隔这么多天——节点撞在一起时也不会连着轰。
 *  取 4 不取 5 是被节点表逼出来的：D3 → D7 只差 4 天，门槛定 5 就会把 D7 的信推到
 *  第 8 天之后。而 D7 是留存的关键断点，晚一天就是晚一天。 */
export const MIN_GAP_DAYS = 4;
/** 今天还活跃的人不需要召回（他人就在这儿） */
export const AWAY_DAYS = 2;

/**
 * 这个节点要求"离开多久"才发。D3 单独放宽到 1 天：D3 本来就是冲着"第三天断崖"去的，
 * 要求连着两天不来，等于 D2 露了一面就把这次干预推迟——那就错过了它唯一想接住的那个人。
 * 后面的节点隔得远，2 天的门槛只起"别打扰还在的人"的作用，不影响时机。
 */
export function awayDaysFor(node: TouchNode): number {
  return node === 'D3' ? 1 : AWAY_DAYS;
}

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
 * 顺序是有意的：opt-in → 刚发过 → 到没到节点 → 发过没有 → 人还在不在。
 * 每一道都是「不发」的理由，最后才轮到「发」。
 * 「人还在不在」挪到最后一道，是因为门槛按节点而定（见 `awayDaysFor`）——得先知道
 * 是哪一封，才知道该用几天的门槛。
 */
export function pickTouchNode(profile: GrowthProfile, now: Date = new Date()): TouchNode | null {
  const touch = profile.touch ?? {};
  if (touch.emailOptIn !== true) return null; // 没同意收信 —— 一封都不发
  if (!touch.unsubToken) return null; // 退不掉的信不发
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
  if (!hit) return null;
  if (daysSinceDate(profile.last_active_date, now) < awayDaysFor(hit)) return null; // 人就在这儿
  return hit;
}

/**
 * 这封信引用的那句话：**取时间上最近的那一句**，信与命题线上的原话放在一起排。
 *
 * 为什么必须按时间排而不是"先看信、信里取最后一条"：一个人第 5 天写了封信，之后
 * 三个月都在对话里留原话——D90 的信却还在引用第 5 天那句，"我记得你"就变成了
 * "我停在你三个月前"。记得住的体感来自**近**，不来自**多**。
 */
export function pickEcho(profile: GrowthProfile): { text: string; from: 'letter' | 'thread' } | null {
  const fromLetters = (profile.letters ?? [])
    .filter((l) => (l.content ?? '').trim())
    .map((l) => ({ text: l.content.trim(), from: 'letter' as const, at: Date.parse(l.createdAt) }));
  const fromThreads = Object.values(profile.threads ?? {})
    .flatMap((t) => t?.evidence ?? [])
    .filter((e) => (e.quote ?? '').trim())
    .map((e) => ({ text: e.quote.trim(), from: 'thread' as const, at: Date.parse(e.at) }));

  const all = [...fromLetters, ...fromThreads].filter((x) => !Number.isNaN(x.at));
  if (!all.length) {
    // 时间戳坏掉的也别丢：宁可引用一句"不知道什么时候说的"，也好过一句都不引用
    const fallback = [...fromLetters, ...fromThreads].pop();
    return fallback ? { text: fallback.text, from: fallback.from } : null;
  }
  const last = all.sort((a, b) => a.at - b.at).pop()!;
  return { text: last.text, from: last.from };
}

export function unsubUrl(baseUrl: string, locale: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/touch/unsubscribe?token=${encodeURIComponent(token)}&locale=${encodeURIComponent(locale)}`;
}

/**
 * 这个节点要问的那一个问题（docs/10 §2.1）。
 *
 * 信里问一次，回程页再问一次——**同一个问题**，同一份文案。只在一处写死，两处引用，
 * 是为了让"他答的是不是我们问的"这件事不需要人去核对：文案改了，两边一起改。
 * 只有 6 个节点问；D3 是"你上次说的那句话我留着"，不提问，所以返回 null。
 */
export function nodeQuestion(dict: Dict, node: string): string | null {
  const tpl = (
    dict.touch.letters as unknown as Record<string, { question?: string } | undefined>
  )[node];
  const q = (tpl?.question ?? '').trim();
  return q || null;
}

function clip(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export interface TouchLetter {
  subject: string;
  text: string;
  html: string;
  /** 退订地址：信里挂一份，信头（List-Unsubscribe）里再挂一份，两处同源 */
  unsub: string;
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
  const tpl = (
    t.letters as unknown as Record<string, { subject: string; body: string; question?: string } | undefined>
  )[node];
  if (!tpl) return null;

  const echo = pickEcho(profile);
  // 有原话就引用他自己的话；没有（还没写过什么）就走不引用的那版，绝不编一句替他说
  const body = echo
    ? tpl.body.replace('{echo}', clip(echo.text))
    : t.bodyNoEcho.replace('{title}', dict.nav.journey);

  // 这个节点要问的那一个问题（docs/10 §2.1）：**信里问，回程页接着问**——
  // 回程页的一格要能认出"我是被哪句话叫回来的"。信里问了，页面才接得上；
  // 页面接不上，回程就只是"点了个链接"，不是"回答了一个问题"。
  const question = (tpl.question ?? '').trim();

  // 带上 from/node：他从哪封信回来的，回来的那一刻才认得出（journey 页据此记一次 touch_return）
  const back = `${baseUrl.replace(/\/$/, '')}/${locale}/journey?from=touch&node=${node}`;
  const unsub = unsubUrl(baseUrl, locale, token);
  const text = [
    body,
    ...(question ? ['', question] : []),
    '',
    `${t.backLabel}: ${back}`,
    '',
    `${t.unsubLead} ${unsub}`,
  ].join('\n');
  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,sans-serif;font-size:15px;line-height:1.9;color:#2b2724;max-width:520px">`,
    ...body.split('\n').map((line) => `<p style="margin:0 0 14px">${escapeHtml(line)}</p>`),
    ...(question
      ? [`<p style="margin:0 0 14px;font-weight:500">${escapeHtml(question)}</p>`]
      : []),
    `<p style="margin:26px 0 0"><a href="${escapeHtml(back)}" style="color:#a4553c">${escapeHtml(t.backLabel)}</a></p>`,
    `<p style="margin:30px 0 0;font-size:12px;color:#9b938c">${escapeHtml(t.unsubLead)} <a href="${escapeHtml(unsub)}" style="color:#9b938c">${escapeHtml(t.unsubLabel)}</a></p>`,
    `</div>`,
  ].join('');
  return { subject: tpl.subject, text, html, unsub };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** RFC 2606 / 6761 保留给测试与文档的域名——真实世界里不存在，寄过去必定硬退 */
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/**
 * 这个地址能不能真寄出去。
 *
 * 为什么要拦：smoke 建的账号是 `xxx@smoke.test`，`.test` 是保留 TLD，永远不会有
 * 收件服务器。真发过去就是一次硬退（hard bounce），而硬退率是发信域名的命根子——
 * 攒够了整个 miller.ink 都会被投递方降权，殃及的是真实用户收不收得到信。
 * 拦在这里而不是让 Resend 去退：退信是全域名共担的成本，本地一行判断是免费的。
 */
export function isDeliverableEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain.includes('.') || /\s/.test(email)) return false;
  if (RESERVED_DOMAINS.includes(domain)) return false;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return !RESERVED_TLDS.includes(tld);
}

/** 触达通道有没有配好——没配不是错误，是"这台机器不发信"，调度器据此优雅降级 */
export function touchConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}
