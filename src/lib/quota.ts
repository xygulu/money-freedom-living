import { createHash, randomUUID } from 'crypto';
import { ensureSchema, execWithFailover } from '@/lib/db';
import { isUserVip } from '@/lib/entitlements';

/**
 * 每日使用量配额（游客/免费/VIP 三档，P§7 精确定义）：
 *   陪伴对话 1 次 = 一次会话（游客 1 会话/天，免费 3 会话/天，VIP 无限≈100 上限兜底）。
 * 体检全流程（问卷/初谈/画像/校准）不占配额（P§7"首次流程不占配额"）。
 * 落账语义"失败不扣"：consume 只在 AI 首条回复成功后发生（chat/[sessionId] 路由）。
 * 计数在服务端：/api/quota/consume 原子地"查数 + 插行"
 * （单条 INSERT ... WHERE count < limit），并发双击也不会超发。
 *
 * 游客身份（guestKey 的来源）按稳定性排序：
 *   1. 匿名 cookie（首次请求种下，httpOnly 90 天）——同一浏览器跨网络稳定；
 *   2. IP 哈希兜底（无 cookie 的请求：首次访问、curl/脚本/爬虫）。
 * ⚠️ 不要把裸客户端 IP 当唯一身份：浏览器 IPv4/IPv6 双栈会逐连接翻转、
 * 代理链路也可能变，展示（GET）与扣减（POST）落进不同桶，就会出现
 * "显示还剩 2 实际只剩 1""显示 0 却还能玩"这类错位（生产实测踩过）。
 * 清 cookie = 新配额，与"换 VPN = 新配额"同级风险，产品上可接受；
 * NAT 共享 IP 的误伤也随 cookie 方案消失（按浏览器而非按 IP 计）。
 *
 * "每天"按 UTC 日切（day 列 = YYYY-MM-DD）：实现简单、无时区配置；
 * 对东八区用户每天前 8 小时属于"前一天"，属已知取舍。
 */

export const GUEST_DAILY_QUOTA = 1;
export const FREE_DAILY_QUOTA = 3;
export const VIP_DAILY_QUOTA = 100;

/** 仅 VIP 可用的功能 key（consumeQuota 的 kind 命中即 403 FEATURE_VIP_ONLY）。
 *  按项目需要往里加，例如 ['custom-scenario', 'export-pdf']。 */
export const VIP_ONLY_KINDS: ReadonlySet<string> = new Set([]);

/** 每日上限（纯函数，便于单测） */
export function dailyLimitFor(authenticated: boolean, isVip: boolean): number {
  if (!authenticated) return GUEST_DAILY_QUOTA;
  return isVip ? VIP_DAILY_QUOTA : FREE_DAILY_QUOTA;
}

/**
 * 当前 UTC 日期（YYYY-MM-DD）。
 * ⚠️ 别拿它当"今天"用在业务里——用户的今天在用户的时区里（见 lib/time.ts 的 todayIn）。
 * 这里只留给没有用户上下文的场合（如系统内部批处理）。
 */
export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * 游客标识：IP + 日期哈希。
 * ⚠️ pepper 换成你自己的固定串即可（泄漏最坏后果是伪造游客配额，无敏感数据）；
 * 换 pepper 会让所有游客的当日计数清零重算，别频繁换。
 */
export const GUEST_KEY_PEPPER = 'saas-kit:quota:v1';

export function guestKeyFromIp(ip: string, day: string): string {
  return createHash('sha256').update(`${GUEST_KEY_PEPPER}:${day}:${ip}`).digest('hex').slice(0, 32);
}

// ---------- 游客匿名 cookie 身份（优先于 IP） ----------

/** 游客身份 cookie 名与 Set-Cookie 值。httpOnly + SameSite=Lax，90 天有效。 */
export const GUEST_ID_COOKIE = 'guest_qk';
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 90;

/** 新游客身份：32 位 hex（无意义随机串，非 PII；guest_key 里还掺了 day，跨日不可关联） */
export function newGuestId(): string {
  return randomUUID().replace(/-/g, '');
}

/** 校验 cookie 里带回来的身份形态（防脏值进哈希） */
export function isValidGuestId(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

export function guestKeyFromId(id: string, day: string): string {
  // ":cookie:" 域分隔：与 IP 哈希的键空间永远不相交（IP 长不成 32 位 hex）
  return createHash('sha256').update(`${GUEST_KEY_PEPPER}:cookie:${day}:${id}`).digest('hex').slice(0, 32);
}

export function guestCookieHeader(id: string): string {
  return `${GUEST_ID_COOKIE}=${id}; Path=/; Max-Age=${GUEST_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`;
}

/**
 * 一次请求的游客身份解析：有效 cookie → 按 cookie 计；否则按 IP 兜底计数
 * 并种一个新 cookie（浏览器第二请求起即稳定）。
 * 返回 newCookieId 非空时，路由要把 `guestCookieHeader(newCookieId)` 挂到响应头。
 * 无 cookie 的脚本/curl 不存 cookie，会一直落在 IP 桶——冒烟测试与限流语义不变。
 */
export function guestKeyForRequest(
  cookieId: string | undefined,
  ip: string,
  day: string
): { guestKey: string; newCookieId: string | null } {
  if (isValidGuestId(cookieId)) {
    return { guestKey: guestKeyFromId(cookieId, day), newCookieId: null };
  }
  return { guestKey: guestKeyFromIp(ip, day), newCookieId: newGuestId() };
}

/** 从代理头取客户端 IP（x-forwarded-for 首个 → x-real-ip → unknown） */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip') ?? 'unknown';
}

export function isVipOnlyKind(kind: string): boolean {
  return VIP_ONLY_KINDS.has(kind);
}

export interface QuotaStatus {
  authenticated: boolean;
  isVip: boolean;
  limit: number;
  used: number;
  remaining: number;
}

/** 查询当日配额使用情况（登录用户按 user_id，游客按 guest_key）。
 *  day 必传：日界线按用户时区算，调用方用 todayIn(tz) 取——这里不给 UTC 默认值，
 *  免得某个调用点漏传就把用户的"今天"悄悄挪回 UTC。 */
export async function getQuotaStatus(input: {
  userId: string | null;
  guestKey: string;
  day: string;
}): Promise<QuotaStatus> {
  const authenticated = Boolean(input.userId);
  const isVip = authenticated ? await isUserVip(input.userId as string) : false;
  const limit = dailyLimitFor(authenticated, isVip);
  const day = input.day;

  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    authenticated
      ? sql`
          SELECT count(*)::int AS used FROM quota_events
          WHERE day = ${day} AND user_id = ${input.userId}
        `
      : sql`
          SELECT count(*)::int AS used FROM quota_events
          WHERE day = ${day} AND guest_key = ${input.guestKey}
        `
  );
  const used = Number(rows[0]?.used ?? 0);
  return { authenticated, isVip, limit, used, remaining: Math.max(0, limit - used) };
}

export type ConsumeResult =
  | { ok: true; status: QuotaStatus }
  | { ok: false; status: QuotaStatus }; // status 供 403 响应带上 limit/used 展示

/**
 * 消耗一次配额：INSERT 语句内原子复检"当日已用 < 上限"，
 * 并发双击也不会超发。失败（超限）返回 ok:false 并携带当前状态。
 * kind 用于区分功能（落 quota_events.kind，也参与 VIP-only 门禁）。
 */
export async function consumeQuota(input: {
  userId: string | null;
  guestKey: string;
  day: string;
  kind?: string;
}): Promise<ConsumeResult> {
  const status = await getQuotaStatus(input);
  if (status.remaining <= 0) return { ok: false, status };

  const day = input.day;
  const kind = input.kind ?? 'default';
  await ensureSchema();
  // ⚠️ 单条 INSERT ... SELECT ... WHERE count < limit：查数与插行在一个原子操作里，
  // 不能拆成"先 SELECT 再 INSERT"（并发窗口会超发）。
  const inserted = await execWithFailover((sql) =>
    input.userId
      ? sql`
          INSERT INTO quota_events (user_id, guest_key, day, kind)
          SELECT ${input.userId}, '', ${day}, ${kind}
          WHERE (SELECT count(*) FROM quota_events WHERE day = ${day} AND user_id = ${input.userId}) < ${status.limit}
          RETURNING id
        `
      : sql`
          INSERT INTO quota_events (guest_key, day, kind)
          SELECT ${input.guestKey}, ${day}, ${kind}
          WHERE (SELECT count(*) FROM quota_events WHERE day = ${day} AND guest_key = ${input.guestKey}) < ${status.limit}
          RETURNING id
        `
  );
  if (inserted.length === 0) return { ok: false, status }; // 并发下被抢完
  return {
    ok: true,
    status: { ...status, used: status.used + 1, remaining: status.remaining - 1 },
  };
}
