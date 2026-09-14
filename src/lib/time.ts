// 用户本地时间（用户需求：AI 的"现在"必须和用户对得上）。
//
// 为什么不用服务器时间：部署在哪台机器上、机器什么时区，跟用户在哪儿没有关系；
// 早先全站按 UTC 切"今天"，北京时间 00:00-08:00 写的东西会被记成前一天，
// 美西用户的每日额度则在当地下午翻页——海外先行的产品不能这样。
//
// 时区来源：浏览器 Intl 报的 IANA 名（如 Asia/Shanghai），由 layout 里的内联脚本
// 写进 mfl_tz cookie。第一次访问的那一个请求还没有 cookie，落回 UTC；脚本在首帧
// 就执行，之后的每个请求（包括所有聊天 API）都带得上。用户换城市会自动刷新。
import type { Locale } from '@/i18n/config';

export const TZ_COOKIE = 'mfl_tz';
export const DEFAULT_TZ = 'UTC';

/** cookie 来自客户端，先当不可信输入验：字符集 + Intl 能否接受 */
export function isValidTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 缺失或不合法一律回落 UTC（宁可全站一致地偏，也不要半途抛错） */
export function normalizeTimeZone(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_TZ;
  const tz = raw.trim();
  return isValidTimeZone(tz) ? tz : DEFAULT_TZ;
}

/** 从 cookie 容器取时区。同时吃 RSC 的 `await cookies()` 与路由的 `request.cookies` */
export function timeZoneFrom(jar: { get(name: string): { value: string } | undefined } | null | undefined): string {
  if (!jar) return DEFAULT_TZ;
  try {
    return normalizeTimeZone(jar.get(TZ_COOKIE)?.value);
  } catch {
    return DEFAULT_TZ;
  }
}

/** 该时区的"今天"（YYYY-MM-DD）。全站日界线唯一真源：配额、记忆日期、锚点日都用它 */
export function todayIn(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 该时区的星期几（0=周日），发薪日锚点用 */
export function weekdayIn(tz: string, now: Date = new Date()): number {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);
}

/** 该时区的几号（1-31） */
export function dayOfMonthIn(tz: string, now: Date = new Date()): number {
  return Number(todayIn(tz, now).slice(8, 10));
}

/** 两个 YYYY-MM-DD 相差几天（to - from）。纯日期算术，不涉时区 */
export function daysBetween(from: string, to: string): number {
  const parse = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/**
 * 记忆日期的远近说法（进提示词用）。模型只看见 [2026-09-13] 是判断不出"上次是昨天
 * 还是三周前"的——它连今天几号都不知道，得由我们把远近直接说出来。
 */
export function relativeDay(locale: Locale, day: string, today: string): string {
  const diff = daysBetween(day, today);
  if (locale === 'en') {
    if (diff <= 0) return 'today';
    if (diff === 1) return 'yesterday';
    if (diff < 7) return `${diff} days ago`;
    if (diff < 30) return `${Math.floor(diff / 7)} week(s) ago`;
    return `${Math.floor(diff / 30)} month(s) ago`;
  }
  if (locale === 'ja') {
    if (diff <= 0) return '今日';
    if (diff === 1) return '昨日';
    if (diff < 7) return `${diff}日前`;
    if (diff < 30) return `${Math.floor(diff / 7)}週間前`;
    return `${Math.floor(diff / 30)}ヶ月前`;
  }
  const tw = locale === 'zh-TW';
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff < 7) return `${diff} 天前`;
  if (diff < 30) return tw ? `${Math.floor(diff / 7)} 週前` : `${Math.floor(diff / 7)} 周前`;
  return tw ? `${Math.floor(diff / 30)} 個月前` : `${Math.floor(diff / 30)} 个月前`;
}

/** 用户那边此刻的完整写法，如「2026年9月14日星期一 09:20」 */
export function localNowText(locale: Locale, tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(now);
}

/**
 * 进 system 的「现在」块。放在语言规则之后、一切内容之前——它是 AI 说"今天/昨天"
 * 时唯一的依据，不该被预算裁掉。别让模型主动报时，那会变成一句突兀的播报。
 */
export function nowBlock(locale: Locale, tz: string, now: Date = new Date()): string {
  const stamp = `${localNowText(locale, tz, now)}（${tz}）`;
  if (locale === 'en') {
    return [
      '## Now',
      `The user's local time is ${localNowText(locale, tz, now)} (${tz}).`,
      '- Anchor "today", "yesterday", "this week" and "lately" to this — not to anything you remember from training.',
      '- Don\'t announce the date or time unless the user asks or it genuinely matters.',
    ].join('\n');
  }
  if (locale === 'ja') {
    return [
      '## いま',
      `ユーザーのいる場所の現在時刻は ${stamp} です。`,
      '- 「今日・昨日・今週・最近」はすべてこの時刻を基準に。学習データの記憶で判断しないこと。',
      '- 聞かれない限り、日時をわざわざ告げないこと。',
    ].join('\n');
  }
  if (locale === 'zh-TW') {
    return [
      '## 現在',
      `用戶那邊現在是 ${stamp}。`,
      '- 說到「今天/昨天/這週/最近」一律以此為準，不要用你訓練資料裡的時間。',
      '- 用戶沒問就別主動報時間，也別把時間本身當話題。',
    ].join('\n');
  }
  return [
    '## 现在',
    `用户那边现在是 ${stamp}。`,
    '- 说到「今天/昨天/这周/最近」一律以此为准，不要用你训练数据里的时间。',
    '- 用户没问就别主动报时间，也别把时间本身当话题。',
  ].join('\n');
}
