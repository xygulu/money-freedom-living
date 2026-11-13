// 「你上次留在这里」（P3-4，2026-09-24）：昨天回响的纯函数口径。
// 铁律来自 docs/06 §2.2：没有就留白不占位；引用的永远是他自己的原话；
// "记得住的体感来自近，不来自多"（pickEcho 同口径——取最近，不取最多）。
import { describe, expect, it } from 'vitest';
import { lastQuoteBefore } from '@/lib/road';
import type { GrowthProfile, ThreadEvidence, ThreadState } from '@/lib/profile';

const ev = (at: string, quote: string): ThreadEvidence => ({
  at,
  bookId: 'money-freedom',
  source: 'close',
  quote,
});

const thread = (evidence: ThreadEvidence[]): ThreadState => ({
  firstSeenAt: evidence[0]?.at ?? '2026-01-01T00:00:00.000Z',
  lastSeenAt: evidence[0]?.at ?? '2026-01-01T00:00:00.000Z',
  depth: 'seen',
  evidence,
});

const profile = (partial: Partial<Pick<GrowthProfile, 'threads' | 'letters'>>): Pick<GrowthProfile, 'threads' | 'letters'> => ({
  threads: {},
  letters: [],
  ...partial,
});

describe('lastQuoteBefore', () => {
  it('空档案 → null（页面留白不占位）', () => {
    expect(lastQuoteBefore(profile({}), '2026-09-24')).toBeNull();
  });

  it('命题线原话与信件放一起取最近的一句（信更近取信，线更近取线）', () => {
    const withCloserLetter = profile({
      threads: { 'money-safety': thread([ev('2026-09-20T10:00:00.000Z', '发薪日我居然没先还花呗')] as never) },
      letters: [{ content: '给钱的一封信的正文', createdAt: '2026-09-23T08:00:00.000Z' } as never],
    });
    expect(lastQuoteBefore(withCloserLetter, '2026-09-24')?.text).toBe('给钱的一封信的正文');
    expect(lastQuoteBefore(withCloserLetter, '2026-09-24')?.from).toBe('letter');

    const withCloserThread = profile({
      threads: { 'money-safety': thread([ev('2026-09-23T22:00:00.000Z', '我昨晚先记了账')] as never) },
      letters: [{ content: '旧信', createdAt: '2026-09-01T08:00:00.000Z' } as never],
    });
    expect(lastQuoteBefore(withCloserThread, '2026-09-24')?.text).toBe('我昨晚先记了账');
    expect(lastQuoteBefore(withCloserThread, '2026-09-24')?.from).toBe('thread');
  });

  it('今天的原话不算"上次"——提交后 MirrorCard 已经照过一次，再摆是复读', () => {
    const p = profile({
      threads: { 'money-safety': thread([ev('2026-09-24T06:00:00.000Z', '今天刚说的这句')] as never) },
    });
    expect(lastQuoteBefore(p, '2026-09-24')).toBeNull();
    // 但到了明天，它就是"上次"了
    expect(lastQuoteBefore(p, '2026-09-25')?.text).toBe('今天刚说的这句');
  });

  it('同一句在多条线/多条证据里，只取最新一条', () => {
    const p = profile({
      threads: {
        'money-safety': thread([ev('2026-09-10T10:00:00.000Z', '旧句')] as never),
        'self-worth': thread([ev('2026-09-22T10:00:00.000Z', '新句')] as never),
      },
    });
    expect(lastQuoteBefore(p, '2026-09-24')?.text).toBe('新句');
  });

  it('超长原话截到 80 字符加省略号（一行内读完）', () => {
    const long = '一'.repeat(120);
    const p = profile({ threads: { 'money-safety': thread([ev('2026-09-20T10:00:00.000Z', long)] as never) } });
    const got = lastQuoteBefore(p, '2026-09-24');
    expect(got?.text.length).toBe(81); // 80 + …
    expect(got?.text.endsWith('…')).toBe(true);
  });

  it('坏时间戳的证据不顶到前面（宁可空着，不给脏数据一个位置）', () => {
    const p = profile({
      threads: { 'money-safety': thread([ev('not-a-date', '坏时间戳的句子')] as never) },
    });
    expect(lastQuoteBefore(p, '2026-09-24')).toBeNull();
  });

  it('空白引语（纯空格）不当成"他说过话"', () => {
    const p = profile({ threads: { 'money-safety': thread([ev('2026-09-20T10:00:00.000Z', '   ')] as never) } });
    expect(lastQuoteBefore(p, '2026-09-24')).toBeNull();
  });
});
