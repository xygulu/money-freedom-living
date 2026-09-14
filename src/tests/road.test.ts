import { describe, expect, it } from 'vitest';
import { buildRoad, inviteBooksFor } from '@/lib/road';
import { DEFAULT_BOOK_ID, TOPICS } from '@/lib/content';
import type { BookEntry, ThreadEvidence, ThreadState } from '@/lib/profile';

// 「你走过的路」（M11-D，docs/05 §3.5）：书在产品里唯一的露出点。
// 守三件事：① 陈列的是他自己的原话，不是结论；② 书只当出处与邀请；
// ③ 还没走到的命题是远处的风景，不混进「走过的路」里当欠账。

const ev = (at: string, quote: string, bookId = DEFAULT_BOOK_ID): ThreadEvidence => ({
  at,
  bookId,
  source: 'assessment',
  quote,
});

const thread = (partial: Partial<ThreadState> & { evidence: ThreadEvidence[] }): ThreadState => ({
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  depth: 'seen',
  ...partial,
});

const book = (bookId: string, startedAt: string): BookEntry => ({
  bookId,
  status: 'active',
  startedAt,
  stage: 1,
  stageStartedAt: startedAt,
});

describe('你走过的路（M11-D）', () => {
  it('空档案：一条路都没有，六个命题全在远处', () => {
    const road = buildRoad({ threads: {}, books: [] });
    expect(road.lines).toEqual([]);
    expect(road.ahead).toEqual([...TOPICS]);
    expect(road.books).toEqual([]);
  });

  it('走过的线排在前面，最近走的在最上；没走过的只进 ahead，不进 lines', () => {
    const road = buildRoad({
      threads: {
        'self-worth': thread({ lastSeenAt: '2026-03-01T00:00:00.000Z', evidence: [ev('2026-03-01T00:00:00.000Z', '我不配闲着')] }),
        parents: thread({ lastSeenAt: '2026-05-01T00:00:00.000Z', evidence: [ev('2026-05-01T00:00:00.000Z', '我妈总说钱要省')] }),
      },
      books: [],
    });
    expect(road.lines.map((l) => l.topic)).toEqual(['parents', 'self-worth']);
    // 走过的不会再出现在「还没走到的地方」——那会变成催他
    expect(road.ahead).not.toContain('parents');
    expect(road.ahead).not.toContain('self-worth');
    expect(road.ahead.length).toBe(TOPICS.length - 2);
  });

  it('陈列的是他自己的原话，新的在前，按 maxQuotes 截断', () => {
    const road = buildRoad(
      {
        threads: {
          allowing: thread({
            lastSeenAt: '2026-06-03T00:00:00.000Z',
            evidence: [
              ev('2026-06-01T00:00:00.000Z', '第一句'),
              ev('2026-06-03T00:00:00.000Z', '第三句'),
              ev('2026-06-02T00:00:00.000Z', '第二句'),
            ],
          }),
        },
        books: [],
      },
      2
    );
    expect(road.lines[0].quotes.map((q) => q.quote)).toEqual(['第三句', '第二句']);
  });

  it('空原话不陈列——物件上没东西就不摆物件', () => {
    const road = buildRoad({
      threads: {
        boundaries: thread({ evidence: [ev('2026-06-01T00:00:00.000Z', '   '), ev('2026-06-02T00:00:00.000Z', '我可以说不')] }),
      },
      books: [],
    });
    expect(road.lines[0].quotes.map((q) => q.quote)).toEqual(['我可以说不']);
  });

  it('书只当出处：按首次出现顺序去重，先走的书排前面', () => {
    const road = buildRoad({
      threads: {
        'money-safety': thread({
          lastSeenAt: '2026-07-03T00:00:00.000Z',
          evidence: [
            ev('2026-07-03T00:00:00.000Z', '第三句', 'book-b'),
            ev('2026-07-01T00:00:00.000Z', '第一句', DEFAULT_BOOK_ID),
            ev('2026-07-02T00:00:00.000Z', '第二句', DEFAULT_BOOK_ID),
          ],
        }),
      },
      books: [],
    });
    expect(road.lines[0].sources).toEqual([DEFAULT_BOOK_ID, 'book-b']);
  });

  it('打开过的书按开始时间排——出处清单是按他走的顺序，不是按书的顺序', () => {
    const road = buildRoad({
      threads: {},
      books: [book('book-b', '2026-08-01T00:00:00.000Z'), book(DEFAULT_BOOK_ID, '2026-02-01T00:00:00.000Z')],
    });
    expect(road.books.map((b) => b.bookId)).toEqual([DEFAULT_BOOK_ID, 'book-b']);
  });

  it('脏时间不抛错、不顶到最前面', () => {
    const road = buildRoad({
      threads: {
        parents: thread({ lastSeenAt: 'not-a-date', evidence: [ev('2026-01-01T00:00:00.000Z', 'a')] }),
        allowing: thread({ lastSeenAt: '2026-04-01T00:00:00.000Z', evidence: [ev('2026-04-01T00:00:00.000Z', 'b')] }),
      },
      books: [],
    });
    expect(road.lines.map((l) => l.topic)).toEqual(['allowing', 'parents']);
  });
});

describe('还有谁说过（docs/05 §3.3 交叉印证）', () => {
  it('已经打开的书不再邀请——v1 只有一本书，所以恒为空', () => {
    const opened = { books: [book(DEFAULT_BOOK_ID, '2026-02-01T00:00:00.000Z')] };
    for (const topic of TOPICS) expect(inviteBooksFor(topic, opened)).toEqual([]);
  });

  it('一本书都没打开时，邀请的候选只能是覆盖了这个命题的在架书', () => {
    for (const topic of TOPICS) {
      for (const b of inviteBooksFor(topic, { books: [] })) {
        expect(b.status).toBe('active');
        expect(b.topics).toContain(topic);
      }
    }
  });
});
