// A1/U1 触达归因链修复（2026-11-13）：归因参数白名单与回程间隔分桶。
// 两个守卫 redirect、新版打点、close 归因字段共用同一处判据——单测把口径钉死，
// 不让 classic / 新版再各自长出一份"长得像但不一样"的判据（纪律④-3）。
import { describe, expect, it } from 'vitest';
import { returnGapBucket, touchReturnQuery } from '@/lib/touch';

describe('touchReturnQuery —— 回程参数白名单', () => {
  it('合法回程（from=touch + 判定节点）原样保留', () => {
    expect(touchReturnQuery({ from: 'touch', node: 'D7' })).toBe('from=touch&node=D7');
    expect(touchReturnQuery({ from: 'touch', node: 'D90' })).toBe('from=touch&node=D90');
  });

  it('D3 也是合法回程（触达节点，只是不提问不判定）', () => {
    expect(touchReturnQuery({ from: 'touch', node: 'D3' })).toBe('from=touch&node=D3');
  });

  it('from 不是 touch 一律拒——归因判据只有这一个来源', () => {
    expect(touchReturnQuery({ from: 'email', node: 'D7' })).toBe('');
    expect(touchReturnQuery({ from: undefined, node: 'D7' })).toBe('');
    expect(touchReturnQuery({ node: 'D7' })).toBe('');
  });

  it('node 不合形制一律拒（防止乱填参数记假归因）', () => {
    expect(touchReturnQuery({ from: 'touch', node: 'X7' })).toBe('');
    expect(touchReturnQuery({ from: 'touch', node: 'd7' })).toBe('');
    expect(touchReturnQuery({ from: 'touch', node: '' })).toBe('');
    expect(touchReturnQuery({ from: 'touch', node: undefined })).toBe('');
  });

  it('无参数 / 空对象 → 空串（redirect 不带问号）', () => {
    expect(touchReturnQuery(undefined)).toBe('');
    expect(touchReturnQuery({})).toBe('');
  });

  it('输出形制固定：k=v&k=v，node 值永远是安全的 D<数字>（正形制放行，无注入面）', () => {
    expect(touchReturnQuery({ from: 'touch', node: 'D7' })).toMatch(/^from=touch&node=D\d+$/);
  });
});

describe('returnGapBucket —— 回程间隔分桶（与 classic 同口径）', () => {
  it('无档案 / last_active_date 缺 → first', () => {
    expect(returnGapBucket(null, '2026-11-13')).toBe('first');
    expect(returnGapBucket(undefined, '2026-11-13')).toBe('first');
  });

  it('同一天 → same_day', () => {
    expect(returnGapBucket('2026-11-13', '2026-11-13')).toBe('same_day');
  });

  it('1-3 天 / 4-7 天 / 8+ 天', () => {
    expect(returnGapBucket('2026-09-23', '2026-11-13')).toBe('1-3');
    expect(returnGapBucket('2026-09-21', '2026-11-13')).toBe('1-3');
    expect(returnGapBucket('2026-09-20', '2026-11-13')).toBe('4-7');
    expect(returnGapBucket('2026-09-17', '2026-11-13')).toBe('4-7');
    expect(returnGapBucket('2026-09-16', '2026-11-13')).toBe('8+');
    expect(returnGapBucket('2026-06-01', '2026-11-13')).toBe('8+');
  });

  it('坏时间戳 → first（宁可当首访，不抛错）', () => {
    expect(returnGapBucket('not-a-date', '2026-11-13')).toBe('first');
    expect(returnGapBucket('2026-11-13', 'also-bad')).toBe('first');
  });
});
