// V0.2 批 C（汇入制加书）：内容面多书化——pickDaily/pickExercise 接受书数组（主线在前），
// 合并各书池子（跨书按文本去重、first-book-wins）、focused 层按各书自己的焦点落在各自的池片上；
// 字符串参数 = 旧单书路径，行为与旧版全同（books.test.ts 守旧路径语义，这里守多书新语义）。
// fixture 惯例同 lamps.test.ts：mock content.json + 让磁盘读取抛错，装载层回落打包副本。
import { describe, expect, it, vi } from 'vitest';
import { getPracticesForStage, pickDaily, pickExercise } from '@/lib/content';

const fixture = vi.hoisted(() => {
  const stageMd = (id: number, title: string, exercises: string[] = []) => ({
    id,
    title,
    goal: '',
    weeks: 1,
    exercises,
    ai_stance: { do: [], dont: [] },
    advance_when: [],
    ritual: '',
    body: '',
  });
  const meta = (id: string) => ({
    id,
    title: { en: id, 'zh-CN': id },
    author: '',
    source: '',
    topics: [],
    status: 'active',
    note: '',
  });
  return {
    books: [meta('test-a'), meta('test-b')],
    journey: {
      'test-a': { 'zh-CN': [stageMd(1, '看见', ['练·甲', '练·乙'])] },
      'test-b': { 'zh-CN': [stageMd(1, '落地', ['练·乙', '练·丙'])] },
    },
    daily: {
      'test-a': {
        'zh-CN': [
          { text: '签·甲', type: 'observation', stages: [1], topics: ['self-worth'], reflection: '' },
          { text: '签·乙', type: 'practice', stages: [1], topics: ['allowing'], reflection: '' },
        ],
      },
      'test-b': {
        'zh-CN': [
          // 跨书重名：签·乙 两本书都有（type/topics 不同）——去重算第一次遇见的那本
          { text: '签·乙', type: 'observation', stages: [1], topics: ['parents'], reflection: '' },
          { text: '签·丙', type: 'way', stages: [1], topics: ['money-safety'], reflection: '' },
        ],
      },
    },
    lamps: {},
    practices: [
      { bookId: 'test-a', stage: 1, body: '创·甲' },
      { bookId: 'test-b', stage: 1, body: '创·乙' },
    ],
    safety: {},
    builtAt: '2026-09-23T00:00:00Z',
  };
});

vi.mock('@/generated/content.json', () => ({ default: fixture }));

// C3 起运行时优先读磁盘 content.json——本测试要用上面的 fixture，就得让磁盘读取
// 失败（抛错），装载层才回落到这份被 mock 的「打包副本」。
vi.mock('node:fs', () => ({
  readFileSync: () => {
    throw new Error('ENOENT (test fixture): content-multibook.test 用 mock 的 content.json，不读磁盘');
  },
}));

const BOOK_A = 'test-a';
const BOOK_B = 'test-b';
const BOTH = [BOOK_A, BOOK_B];
const sweepDate = (i: number) => `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;

describe('pickDaily 多书（汇入制）', () => {
  it('兼容护栏：字符串参数行为与旧版全同——只出该书自己的签，逐日确定', () => {
    for (let i = 0; i < 60; i++) {
      const date = sweepDate(i);
      const card = pickDaily('zh-CN', date, 1, [], BOOK_A);
      expect(['签·甲', '签·乙']).toContain(card?.text);
      expect(pickDaily('zh-CN', date, 1, [], BOOK_A)?.text).toBe(card?.text);
    }
  });

  it('合并池含两书：sweep 多日能抽到三句（甲/乙/丙），逐日确定性', () => {
    const refs = BOTH.map((bookId) => ({ bookId }));
    const seen = new Set<string>();
    for (let i = 0; i < 90; i++) {
      const date = sweepDate(i);
      const card = pickDaily('zh-CN', date, 1, [], refs);
      expect(card, `${date} 应有签`).toBeTruthy();
      seen.add(card!.text);
      expect(pickDaily('zh-CN', date, 1, [], refs)?.text).toBe(card!.text);
    }
    expect(seen).toEqual(new Set(['签·甲', '签·乙', '签·丙']));
  });

  it('跨书 text 去重 first-book-wins：签·乙 永远是主线（test-a）那本的 type=practice', () => {
    const refs = BOTH.map((bookId) => ({ bookId }));
    for (let i = 0; i < 90; i++) {
      const card = pickDaily('zh-CN', sweepDate(i), 1, [], refs);
      if (card?.text === '签·乙') expect(card.type, '重名签应取主线那本').toBe('practice');
    }
  });

  it('focused 按书级焦点落在各自的池片上：A 设焦点 → 永远 A 池片里该命题的签', () => {
    for (let i = 0; i < 20; i++) {
      const card = pickDaily('zh-CN', `2026-05-${String(i + 1).padStart(2, '0')}`, 1, [], [
        { bookId: BOOK_A, focusTopic: 'allowing' },
        { bookId: BOOK_B },
      ]);
      expect(card?.text).toBe('签·乙'); // A 池片里唯一 allowing 的签
    }
  });

  it('B 设焦点：乙被主线占去后，B 池片只剩 丙（money-safety）→ 永远抽到它', () => {
    for (let i = 0; i < 20; i++) {
      const card = pickDaily('zh-CN', `2026-06-${String(i + 1).padStart(2, '0')}`, 1, [], [
        { bookId: BOOK_A },
        { bookId: BOOK_B, focusTopic: 'money-safety' },
      ]);
      expect(card?.text).toBe('签·丙');
    }
  });

  it('seen 去重跨书生效：看过的文本在任一本书里都不再当候选', () => {
    const seen = ['签·甲', '签·乙'];
    for (let i = 0; i < 20; i++) {
      const card = pickDaily('zh-CN', `2026-07-${String(i + 1).padStart(2, '0')}`, 1, seen, BOTH.map((bookId) => ({ bookId })));
      expect(card?.text).toBe('签·丙'); // 唯一未看的
    }
  });
});

describe('pickExercise 多书（汇入制）', () => {
  it('兼容护栏：字符串参数只出该书阶段的练习，逐日确定', () => {
    for (let i = 0; i < 60; i++) {
      const date = sweepDate(i);
      const ex = pickExercise('zh-CN', date, 1, 'u1', BOOK_A);
      expect(['练·甲', '练·乙']).toContain(ex);
      expect(pickExercise('zh-CN', date, 1, 'u1', BOOK_A)).toBe(ex);
    }
  });

  it('union 两书（主线在前，跨书去重）：sweep 能抽到三款，重名的 练·乙 算一条', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 90; i++) {
      const date = sweepDate(i);
      const ex = pickExercise('zh-CN', date, 1, 'u1', BOTH);
      expect(ex, `${date} 应有练习`).toBeTruthy();
      seen.add(ex!);
      expect(pickExercise('zh-CN', date, 1, 'u1', BOTH)).toBe(ex);
    }
    expect(seen).toEqual(new Set(['练·甲', '练·乙', '练·丙']));
  });

  it('去重可观察：合并池是 3 条而非 4 条——所有落点都落在 3 条池的取模格上', () => {
    // 若不去重（池=甲乙乙丙 4 条），某些日期会落在第 3 格（重复的 乙）——
    // 用合并池顺序 + djb2 hash 重算每个日期的落点，期望与实际一致
    const pool = ['练·甲', '练·乙', '练·丙'];
    for (let i = 0; i < 90; i++) {
      const date = sweepDate(i);
      let h = 5381;
      for (const ch of `${date}#u1`) h = (Math.imul(h, 33) + ch.charCodeAt(0)) | 0;
      h ^= h >>> 16;
      h = Math.imul(h, 2246822507);
      h ^= h >>> 13;
      h = Math.imul(h, 3266489909);
      h ^= h >>> 16;
      const expected = pool[(h >>> 0) % pool.length];
      expect(pickExercise('zh-CN', date, 1, 'u1', BOTH)).toBe(expected);
    }
  });
});

describe('practices union（chat 块同源）', () => {
  it('getPracticesForStage 按书过滤，多书 flatMap 合并主线在前', () => {
    const merged = BOTH.flatMap((id) => getPracticesForStage(1, id));
    expect(merged.map((p) => p.body)).toEqual(['创·甲', '创·乙']);
  });
});
