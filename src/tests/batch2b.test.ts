// 批 2b（A2/A4/A5，2026-09-24）纯函数口径：
// - normalizeSeedQuote：球气泡原文进对话历史前的清洗（A4）
// - isMonthEndISO / anchorKindForToday：nudge L1d 日历触发的判定（A5）
import { describe, expect, it } from 'vitest';
import { normalizeSeedQuote } from '@/lib/chat';
import { anchorKindForToday, isMonthEndISO } from '@/lib/anchor';

describe('normalizeSeedQuote（A4）', () => {
  it('正常 nudge 文案原样保留', () => {
    expect(normalizeSeedQuote('今天是你自己设的锚点日。')).toBe('今天是你自己设的锚点日。');
  });

  it('折叠空白 + 去首尾（URL 解码后的多行/多余空格不进历史）', () => {
    expect(normalizeSeedQuote('  上次你说「X」——\n  这一周它在不在？  ')).toBe('上次你说「X」—— 这一周它在不在？');
  });

  it('超 300 字符截断（nudge 本身 ≤80，这是防御上限）', () => {
    expect(normalizeSeedQuote('a'.repeat(400)).length).toBe(300);
  });

  it('非字符串 / 空串 / 纯空白 → 空串（不存空消息）', () => {
    expect(normalizeSeedQuote(undefined)).toBe('');
    expect(normalizeSeedQuote(123)).toBe('');
    expect(normalizeSeedQuote('')).toBe('');
    expect(normalizeSeedQuote('   ')).toBe('');
  });
});

describe('isMonthEndISO（A5）', () => {
  it('月末当天为 true（含闰年 2/29、平年 2/28）', () => {
    expect(isMonthEndISO('2026-09-30')).toBe(true);
    expect(isMonthEndISO('2026-02-28')).toBe(true);
    expect(isMonthEndISO('2024-02-29')).toBe(true); // 闰年
    expect(isMonthEndISO('2026-12-31')).toBe(true);
  });

  it('非月末为 false', () => {
    expect(isMonthEndISO('2026-09-29')).toBe(false);
    expect(isMonthEndISO('2024-02-28')).toBe(false); // 闰年 2 月有 29 天
    expect(isMonthEndISO('2025-02-27')).toBe(false);
  });

  it('坏形制一律 false', () => {
    expect(isMonthEndISO('not-a-date')).toBe(false);
    expect(isMonthEndISO('2026-9-30')).toBe(false);
    expect(isMonthEndISO('')).toBe(false);
  });
});

describe('anchorKindForToday（A5）', () => {
  // 固定 now：2026-09-30 是 9 月最后一天（发薪日 monthly 限 1-28 号，AnchorCard 同款约束）
  const now = new Date('2026-09-30T12:00:00.000Z');

  it('发薪日命中优先于月末（28 号那天设了 monthly day 28）', () => {
    const d28 = new Date('2026-09-28T12:00:00.000Z');
    expect(anchorKindForToday({ type: 'monthly', day: 28 }, 'UTC', d28)).toBe('payday');
  });

  it('没设发薪日 → 月末兜底', () => {
    expect(anchorKindForToday(null, 'UTC', now)).toBe('month_end');
    expect(anchorKindForToday(undefined, 'UTC', now)).toBe('month_end');
  });

  it('既不是发薪日也不是月末 → null（不催不猜）', () => {
    const mid = new Date('2026-09-15T12:00:00.000Z');
    expect(anchorKindForToday(null, 'UTC', mid)).toBeNull();
    expect(anchorKindForToday({ type: 'monthly', day: 10 }, 'UTC', mid)).toBeNull();
  });

  it('月末按用户时区算（UTC 还是 9/30 时，东八区已是 10/1，非月末）', () => {
    const nearMidnight = new Date('2026-09-30T17:00:00.000Z'); // UTC 17:00 = +08:00 的 10/01 01:00
    expect(anchorKindForToday(null, 'Asia/Shanghai', nearMidnight)).toBeNull();
    expect(anchorKindForToday(null, 'UTC', nearMidnight)).toBe('month_end');
  });

  it('大促永不猜测（无 sale 分支产出）', () => {
    // 双十一这类"大促"不在可判定信号里——永远只可能是 payday/month_end/null
    const kinds = new Set(['payday', 'month_end', null]);
    expect(kinds.has(anchorKindForToday(null, 'UTC', now))).toBe(true);
  });
});
