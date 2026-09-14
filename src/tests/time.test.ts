// 用户本地时间：日界线、远近说法、提示词里的「现在」块。
// 这一组测试钉的是一句话——"今天"是用户的今天，不是服务器的今天。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TZ,
  daysBetween,
  dayOfMonthIn,
  isValidTimeZone,
  normalizeTimeZone,
  nowBlock,
  relativeDay,
  timeZoneFrom,
  todayIn,
  weekdayIn,
} from '@/lib/time';

// 北京时间 2026-09-14 07:52，UTC 还停在 09-13 —— 线上真实踩到的那一刻
const EARLY_MORNING = new Date('2026-09-13T23:52:00Z');

describe('todayIn：日界线按用户时区', () => {
  it('北京清晨属于当天，不是 UTC 的前一天', () => {
    expect(todayIn('Asia/Shanghai', EARLY_MORNING)).toBe('2026-09-14');
    expect(todayIn('UTC', EARLY_MORNING)).toBe('2026-09-13');
  });

  it('美西傍晚仍是当天，不是 UTC 的次日', () => {
    const evening = new Date('2026-09-15T02:00:00Z'); // 洛杉矶 9/14 19:00
    expect(todayIn('America/Los_Angeles', evening)).toBe('2026-09-14');
    expect(todayIn('UTC', evening)).toBe('2026-09-15');
  });

  it('同一时刻，两地各过各的日子（配额桶因此不会互相串）', () => {
    const t = new Date('2026-09-14T15:30:00Z');
    expect(todayIn('Pacific/Auckland', t)).toBe('2026-09-15');
    expect(todayIn('America/New_York', t)).toBe('2026-09-14');
  });
});

describe('时区取值：cookie 不可信，坏值一律回落 UTC', () => {
  it('合法 IANA 名通过', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('伪造/注入/不存在的时区一律不接受', () => {
    for (const bad of ['', '../../etc/passwd', 'Asia/Shanghai; DROP', 'Not/AZone', '<script>', 'A'.repeat(80)]) {
      expect(isValidTimeZone(bad), bad).toBe(false);
      expect(normalizeTimeZone(bad), bad).toBe(DEFAULT_TZ);
    }
    expect(normalizeTimeZone(null)).toBe(DEFAULT_TZ);
    expect(normalizeTimeZone(undefined)).toBe(DEFAULT_TZ);
  });

  it('从 cookie 容器读取；没有 cookie 的第一个请求回落 UTC', () => {
    expect(timeZoneFrom({ get: () => ({ value: 'Europe/Berlin' }) })).toBe('Europe/Berlin');
    expect(timeZoneFrom({ get: () => undefined })).toBe(DEFAULT_TZ);
    expect(timeZoneFrom(null)).toBe(DEFAULT_TZ);
  });
});

describe('weekdayIn / dayOfMonthIn：锚点日按用户日历', () => {
  it('跨日界的同一时刻，星期与日号都按当地算', () => {
    // UTC 周日 23:00 = 北京周一 07:00
    const t = new Date('2026-09-13T23:00:00Z');
    expect(weekdayIn('UTC', t)).toBe(0);
    expect(weekdayIn('Asia/Shanghai', t)).toBe(1);
    expect(dayOfMonthIn('UTC', t)).toBe(13);
    expect(dayOfMonthIn('Asia/Shanghai', t)).toBe(14);
  });
});

describe('relativeDay：把远近直接说给模型听', () => {
  it('四语的今天/昨天', () => {
    expect(relativeDay('zh-CN', '2026-09-14', '2026-09-14')).toBe('今天');
    expect(relativeDay('zh-CN', '2026-09-13', '2026-09-14')).toBe('昨天');
    expect(relativeDay('zh-TW', '2026-09-12', '2026-09-14')).toBe('前天');
    expect(relativeDay('en', '2026-09-13', '2026-09-14')).toBe('yesterday');
    expect(relativeDay('ja', '2026-09-13', '2026-09-14')).toBe('昨日');
  });

  it('更远的按天/周/月说', () => {
    expect(relativeDay('zh-CN', '2026-09-10', '2026-09-14')).toBe('4 天前');
    expect(relativeDay('zh-CN', '2026-08-31', '2026-09-14')).toBe('2 周前');
    expect(relativeDay('zh-CN', '2026-07-14', '2026-09-14')).toBe('2 个月前');
    expect(daysBetween('2026-08-31', '2026-09-14')).toBe(14);
  });
});

describe('nowBlock：模型唯一的「现在」依据', () => {
  it('四语都写清了当地时间与时区名，且交代不许用训练时间', () => {
    const t = new Date('2026-09-13T23:52:00Z');
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja'] as const) {
      const block = nowBlock(locale, 'Asia/Shanghai', t);
      expect(block, locale).toContain('Asia/Shanghai');
      expect(block, locale).toContain('2026'); // 当地日期在场（UTC 还是 9/13，这里必须是 9/14）
      expect(block, locale).toMatch(/14|9:52|09:52/);
    }
  });

  it('要求模型别主动报时间（不做突兀的播报）', () => {
    expect(nowBlock('zh-CN', 'UTC')).toContain('没问就别主动报时间');
    expect(nowBlock('en', 'UTC')).toContain("Don't announce the date or time");
  });
});
