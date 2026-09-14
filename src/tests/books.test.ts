import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOK_ID, TOPICS, bookTitle, getBook, getBooks, getJourneyStages, getPracticesForStage } from '@/lib/content';
import { BOOK_LAMPS, STAGE_LAMPS, lampDepth, lampsFor } from '@/lib/stage';
import { mergeDepth, parseBooks } from '@/lib/profile';
import { buildThreadBlock } from '@/lib/prompt';
import type { ThreadState } from '@/lib/profile';

// M11-A 多书架构（docs/05）：成长归用户 / 书是内容层 / 命题线是桥。
// 这里守三件事：① 存量单书用户读出来跟以前一模一样；② 灯能按书索引且未知书有兜底；
// ③ 命题上的程度只增不减、跨书原话调得出来。

describe('内容层的书维度（M11-B）', () => {
  it('v1 的书在场，书名四语齐全', () => {
    const books = getBooks();
    expect(books.map((b) => b.id)).toContain(DEFAULT_BOOK_ID);
    const book = getBook(DEFAULT_BOOK_ID)!;
    expect(book.status).toBe('active');
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja']) {
      expect(book.title[locale]?.length).toBeGreaterThan(0);
    }
    // 覆盖命题必须都在六命题表里（换书时按命题做交叉印证的前提）
    for (const t of book.topics) expect(TOPICS).toContain(t);
  });

  it('bookId 缺省 = v1 的书：既有调用点零改动也读到同一批内容', () => {
    expect(getJourneyStages('zh-CN')).toEqual(getJourneyStages('zh-CN', DEFAULT_BOOK_ID));
    expect(getJourneyStages('zh-CN').length).toBe(4);
    // 不存在的书不抛错、返回空——渲染层自己决定怎么兜
    expect(getJourneyStages('zh-CN', 'no-such-book')).toEqual([]);
    expect(bookTitle('no-such-book', 'zh-CN')).toBe('no-such-book');
  });

  it('创造者笔记带 bookId，按书收窄后仍读得到', () => {
    const all = getPracticesForStage(1);
    const mine = getPracticesForStage(1, DEFAULT_BOOK_ID);
    expect(mine).toEqual(all);
    expect(getPracticesForStage(1, 'no-such-book')).toEqual([]);
  });
});

describe('灯按书索引（M11-A / docs/05 §4.6）', () => {
  it('每盏灯都挂在一条命题线上——这是书与人之间的桥', () => {
    for (const rules of Object.values(STAGE_LAMPS)) {
      for (const rule of rules) expect(TOPICS).toContain(rule.topic);
    }
  });

  it('lampsFor 与既有的 STAGE_LAMPS[stage] 逐项一致（存量调用点不受影响）', () => {
    for (const stage of [1, 2, 3, 4]) {
      expect(lampsFor(DEFAULT_BOOK_ID, stage)).toEqual(STAGE_LAMPS[stage] ?? []);
    }
    expect(BOOK_LAMPS[DEFAULT_BOOK_ID]).toBe(STAGE_LAMPS);
  });

  it('未知的书回落到 v1 的路线图——路线图不能是空的', () => {
    expect(lampsFor('no-such-book', 2)).toEqual(STAGE_LAMPS[2]);
  });

  it('灯亮之后落在命题上的程度：认知类=看见、行为类=换过做法、本段全亮=走完', () => {
    const cognitive = STAGE_LAMPS[2].find((r) => !r.needsAction)!;
    const behavioral = STAGE_LAMPS[2].find((r) => r.needsAction)!;
    expect(lampDepth(cognitive, false)).toBe('seen');
    expect(lampDepth(behavioral, false)).toBe('replaced');
    expect(lampDepth(cognitive, true)).toBe('mastered');
  });
});

describe('程度只增不减（换书不重置，docs/05 §3.2）', () => {
  it('更浅的程度覆盖不了更深的', () => {
    expect(mergeDepth(undefined, 'seen')).toBe('seen');
    expect(mergeDepth('seen', 'replaced')).toBe('replaced');
    expect(mergeDepth('replaced', 'seen')).toBe('replaced');
    expect(mergeDepth('mastered', 'replaced')).toBe('mastered');
  });
});

describe('存量档案读时归位（docs/05 §4.1，不写迁移脚本）', () => {
  const stageStartedAt = '2026-09-01T00:00:00Z';
  const createdAt = '2026-08-01T00:00:00Z';

  it('没有 books 的存量用户：读出来就是"正在读 v1 那本书"，段数取行级 stage', () => {
    const books = parseBooks(undefined, 2, stageStartedAt, createdAt);
    expect(books).toEqual([
      { bookId: DEFAULT_BOOK_ID, status: 'active', startedAt: createdAt, stage: 2, stageStartedAt },
    ]);
  });

  it('当前书的段数以行级 stage 为唯一真源——books 里的旧值不会跟它打架', () => {
    const stale = [{ bookId: DEFAULT_BOOK_ID, status: 'active', startedAt: createdAt, stage: 1, stageStartedAt: createdAt }];
    const books = parseBooks(stale, 3, stageStartedAt, createdAt);
    expect(books[0].stage).toBe(3);
    expect(books[0].stageStartedAt).toBe(stageStartedAt);
  });

  it('读完的书保留自己的段数，不被当前 stage 覆盖', () => {
    const raw = [
      { bookId: 'old-book', status: 'done', startedAt: createdAt, stage: 4, stageStartedAt: createdAt, finishedAt: createdAt },
      { bookId: DEFAULT_BOOK_ID, status: 'active', startedAt: createdAt, stage: 1, stageStartedAt: createdAt },
    ];
    const books = parseBooks(raw, 2, stageStartedAt, createdAt);
    expect(books[0]).toMatchObject({ bookId: 'old-book', status: 'done', stage: 4 });
    expect(books[1].stage).toBe(2);
  });

  it('脏数据（非数组 / 缺 bookId）不至于让人丢掉自己的书', () => {
    expect(parseBooks('坏了', 1, stageStartedAt, createdAt)[0].bookId).toBe(DEFAULT_BOOK_ID);
    expect(parseBooks([{ status: 'active' }], 1, stageStartedAt, createdAt)[0].bookId).toBe(DEFAULT_BOOK_ID);
  });
});

describe('命题线进 prompt（docs/05 §3.3 交叉印证）', () => {
  const thread = (over: Partial<ThreadState> = {}): ThreadState => ({
    firstSeenAt: '2026-08-01T00:00:00Z',
    lastSeenAt: '2026-09-01T00:00:00Z',
    depth: 'seen',
    evidence: [],
    ...over,
  });

  it('没有证据就不占 prompt 预算', () => {
    expect(buildThreadBlock(undefined, DEFAULT_BOOK_ID)).toBeNull();
    expect(buildThreadBlock({ allowing: thread() }, DEFAULT_BOOK_ID)).toBeNull();
  });

  it('调得出他自己的原话，并标明是上一本书里说的', () => {
    const block = buildThreadBlock(
      {
        allowing: thread({
          depth: 'replaced',
          evidence: [
            { at: '2026-08-10T00:00:00Z', bookId: 'old-book', source: 'assessment', quote: '我把那只杯子拿出来用了' },
          ],
        }),
      },
      DEFAULT_BOOK_ID,
    )!;
    expect(block).toContain('我把那只杯子拿出来用了');
    expect(block).toContain('（上一本书里）');
    expect(block).toContain('别当新话题从头讲');
  });

  it('同一本书里的原话不加"上一本书"的标注', () => {
    const block = buildThreadBlock(
      {
        'money-safety': thread({
          evidence: [{ at: '2026-09-02T00:00:00Z', bookId: DEFAULT_BOOK_ID, source: 'chat', quote: '这个月我没有像以前那样慌' }],
        }),
      },
      DEFAULT_BOOK_ID,
    )!;
    expect(block).toContain('这个月我没有像以前那样慌');
    expect(block).not.toContain('（上一本书里）');
  });
});
