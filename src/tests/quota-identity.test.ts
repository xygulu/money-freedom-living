/**
 * 配额身份与档位单测（纯函数，无 DB）。
 *
 * 锁住三件事：
 * 1. 三档每日上限的判定
 * 2. 游客身份解析——有效 cookie 走 cookie 桶且不再发新 cookie；
 *    无/脏 cookie 走 IP 兜底桶并种新 cookie（冒烟 curl 不带 cookie 时
 *    仍按 IP 计数，语义与限流不变）
 * 3. cookie 桶与 IP 桶键空间不相交、跨日/跨身份必不同（防配额桶串号）
 */
import { describe, expect, it } from 'vitest';

import {
  dailyLimitFor,
  guestCookieHeader,
  guestKeyForRequest,
  guestKeyFromId,
  guestKeyFromIp,
  isValidGuestId,
  newGuestId,
  GUEST_ID_COOKIE,
} from '@/lib/quota';

const DAY = '2026-09-07';

describe('每日上限三档（P§7：游客 1 会话/免费 3 会话/VIP 无限≈100 兜底）', () => {
  it('游客 1 / 免费 3 / VIP 100', () => {
    expect(dailyLimitFor(false, false)).toBe(1);
    expect(dailyLimitFor(true, false)).toBe(3);
    expect(dailyLimitFor(true, true)).toBe(100);
  });
});

describe('游客身份解析', () => {
  it('有效 cookie：按 cookie 计，且不发新 cookie', () => {
    const id = newGuestId();
    const a = guestKeyForRequest(id, '203.0.113.7', DAY);
    expect(a.newCookieId).toBeNull();
    expect(a.guestKey).toBe(guestKeyFromId(id, DAY));

    const b = guestKeyForRequest(id, '198.51.100.9', DAY);
    // 同一 cookie 换 IP（v4/v6 翻转、换网络）：桶不变——这正是 cookie 身份的意义
    expect(b.guestKey).toBe(a.guestKey);
  });

  it('无 cookie：按 IP 兜底计数并种新身份（curl/脚本不存 cookie，语义不变）', () => {
    const r = guestKeyForRequest(undefined, '203.0.113.7', DAY);
    expect(r.guestKey).toBe(guestKeyFromIp('203.0.113.7', DAY));
    expect(r.newCookieId).not.toBeNull();
    expect(isValidGuestId(r.newCookieId)).toBe(true);
  });

  it('脏 cookie 值不进哈希，视同无 cookie', () => {
    for (const dirty of ['', 'x', "../etc/passwd", `${'a'.repeat(31)}`, `${'a'.repeat(33)}`]) {
      const r = guestKeyForRequest(dirty, '203.0.113.7', DAY);
      expect(r.guestKey).toBe(guestKeyFromIp('203.0.113.7', DAY));
      expect(r.newCookieId).not.toBeNull();
    }
  });

  it('键空间不相交：cookie 桶 ≠ 任何 IP 桶；跨日/跨身份必不同', () => {
    const id = newGuestId();
    expect(guestKeyFromId(id, DAY)).not.toBe(guestKeyFromIp(id, DAY));
    expect(guestKeyFromId(id, DAY)).not.toBe(guestKeyFromId(newGuestId(), DAY));
    expect(guestKeyFromId(id, DAY)).not.toBe(guestKeyFromId(id, '2026-09-08'));
    expect(guestKeyFromIp('203.0.113.7', DAY)).not.toBe(guestKeyFromIp('203.0.113.8', DAY));
  });
});

describe('身份 cookie', () => {
  it('Set-Cookie 头：httpOnly + SameSite=Lax + 90 天', () => {
    const header = guestCookieHeader(newGuestId());
    expect(header.startsWith(`${GUEST_ID_COOKIE}=`)).toBe(true);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=7776000');
    expect(header).toContain('Path=/');
  });
});
