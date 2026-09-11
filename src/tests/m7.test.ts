// M7 单测：周期锚点（锚点日判定/输入校验）+ 恢复码（字符集/归一化/哈希稳定）
// + 隐私政策四语完整性 + 同意政策版本常量。
import { describe, expect, it } from 'vitest';
import { isAnchorDay, parsePaydayInput, type Payday } from '@/lib/anchor';
import { generateRecoveryCode, normalizeCode, formatCode, hashRecoveryCode, RECOVERY_CODE_LENGTH } from '@/lib/recovery';
import { PRIVACY } from '@/lib/privacy';
import { POLICY_VERSION } from '@/lib/consent';
import { dateColumnToISO } from '@/lib/profile';
import { enabledLocales } from '@/i18n/config';

describe('isAnchorDay（docs/02 §5：默认不猜，锚点日被动感知）', () => {
  // 2026-09-10 是周四；2026-09-15 是周二
  const thu = new Date('2026-09-10T12:00:00Z');

  it('monthly：日期命中才显示，1-28 之外不合法即永不显示', () => {
    const p: Payday = { type: 'monthly', day: 10 };
    expect(isAnchorDay(p, new Date('2026-09-10T02:00:00Z'))).toBe(true);
    expect(isAnchorDay(p, new Date('2026-09-09T23:59:00Z'))).toBe(false);
    expect(isAnchorDay({ type: 'monthly', day: 10 }, new Date('2026-10-10T00:01:00Z'))).toBe(true); // 每月都提
  });

  it('weekly：星期命中即显示', () => {
    expect(isAnchorDay({ type: 'weekly', day: 4 }, thu)).toBe(true); // 周四 = 4
    expect(isAnchorDay({ type: 'weekly', day: 1 }, thu)).toBe(false);
  });

  it('biweekly：星期命中 + epoch 偶数周才显示（相位近似）', () => {
    const week = Math.floor((thu.getTime() / 86_400_000 + 4) / 7);
    const payday: Payday = { type: 'biweekly', day: 4 };
    expect(isAnchorDay(payday, thu)).toBe(week % 2 === 0);
    // 无论相位，非锚定星期永不命中
    expect(isAnchorDay(payday, new Date('2026-09-11T12:00:00Z'))).toBe(false);
  });

  it('day 缺失/越界一律不显示（不猜）', () => {
    expect(isAnchorDay({ type: 'monthly' }, thu)).toBe(false);
    expect(isAnchorDay({ type: 'weekly' }, thu)).toBe(false);
    expect(isAnchorDay({ type: 'monthly', day: 29 }, new Date('2026-09-29T00:00:00Z'))).toBe(false);
  });
});

describe('parsePaydayInput', () => {
  it('null = 清除锚点（合法输入）', () => {
    expect(parsePaydayInput(null)).toBeNull();
  });
  it('非法 type/day → undefined（路由回 400）', () => {
    expect(parsePaydayInput(undefined)).toBeUndefined();
    expect(parsePaydayInput({ type: 'yearly', day: 1 })).toBeUndefined();
    expect(parsePaydayInput({ type: 'monthly', day: 0 })).toBeUndefined();
    expect(parsePaydayInput({ type: 'monthly', day: 29 })).toBeUndefined();
    expect(parsePaydayInput({ type: 'weekly', day: 7 })).toBeUndefined();
    expect(parsePaydayInput({ type: 'monthly', day: '10' })).toBeUndefined();
  });
  it('合法 monthly/weekly 原样通过', () => {
    expect(parsePaydayInput({ type: 'monthly', day: 25 })).toEqual({ type: 'monthly', day: 25 });
    expect(parsePaydayInput({ type: 'weekly', day: 0 })).toEqual({ type: 'weekly', day: 0 });
  });
});

describe('恢复码（docs/03 §4：12 位去易混字符，只存哈希）', () => {
  it('长度 12，字符集不含易混字符（0/1/I/L/O）', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRecoveryCode();
      expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]+$/);
    }
  });

  it('normalize：去分隔符、转大写、剔除无关字符', () => {
    expect(normalizeCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizeCode('abcd efgh jkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizeCode('A-B.C,D')).toBe('ABCD');
  });

  it('formatCode 展示 4-4-4', () => {
    expect(formatCode('23456789ABCDEFGH')).toBe('2345-6789-ABCD');
  });

  it('哈希稳定且区分大小（同码同哈希，微小差异不同哈希），归一化后一致', () => {
    const a = hashRecoveryCode('2345-6789-ABCD');
    expect(a).toBe(hashRecoveryCode('23456789ABCD')); // 归一化后同源
    expect(a).not.toBe(hashRecoveryCode('2345-6789-ABCE'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('隐私政策四语完整性（P§9 合规清单）', () => {
  it.each(enabledLocales)('%s：结构完整，含数据流/权利/删除时间线/18+', (locale) => {
    const text = PRIVACY[locale];
    expect(text.title.length).toBeGreaterThan(0);
    expect(text.updated).toMatch(/2026-09-v1/);
    expect(text.intro.length).toBeGreaterThanOrEqual(2);
    expect(text.sections.length).toBeGreaterThanOrEqual(6);
    for (const section of text.sections) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.paragraphs.length).toBeGreaterThanOrEqual(1);
      for (const p of section.paragraphs) expect(p.length).toBeGreaterThan(0);
    }
    const all = text.sections.map((s) => s.paragraphs.join('\n')).join('\n');
    // 数据流图（设备 → 服务器 → 模型 → 回到设备）
    expect(text.sections.some((s) => s.paragraphs.some((p) => p.includes('→')))).toBe(true);
    // 删除时间线：备份 30 天滚动清除
    expect(all).toMatch(/30/);
    // 18+ 声明
    expect(all).toMatch(/18/);
  });

  it('四语 section 标题一一对应（同一政策的不同语言版本，结构一致）', () => {
    const titles = enabledLocales.map((locale) => PRIVACY[locale].sections.map((s) => s.title).length);
    expect(new Set(titles).size).toBe(1);
  });
});

describe('同意政策版本（P§9：同意记录带政策版本号）', () => {
  it('版本号与隐私政策标注一致', () => {
    expect(POLICY_VERSION).toBe('2026-09-v1');
  });
});

describe('dateColumnToISO（Neon HTTP 驱动 DATE → Date 对象回归）', () => {
  it('Date（本地时区午夜）归一化为该日本地日期串；字符串原样；其余 null', () => {
    // +08 时区下 2026-09-06 00:00 CST = 2026-09-05T16:00:00Z，toISOString 会错回前一天
    const cst = new Date('2026-09-06T00:00:00+08:00');
    expect(dateColumnToISO(cst)).toBe('2026-09-06');
    expect(dateColumnToISO('2026-09-06')).toBe('2026-09-06');
    expect(dateColumnToISO(null)).toBeNull();
    expect(dateColumnToISO(undefined)).toBeNull();
  });
});
