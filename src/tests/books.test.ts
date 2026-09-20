import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOK_ID, TOPICS, bookTitle, getBook, getBooks, getBookLamps, getJourneyStages, getPracticesForStage, getDailyPool, pickDaily, stageCountFor } from '@/lib/content';
import {
  actionEvidenceKinds,
  computeStageProgress,
  lampDepth,
  lampsFor,
  stageAdvanceTarget,
  stageLampScales,
} from '@/lib/stage';
import { mergeDepth, parseBooks } from '@/lib/profile';
import { buildThreadBlock } from '@/lib/prompt';
import type { GrowthProfile, ThreadState } from '@/lib/profile';

// M11-A 多书架构（docs/05）：成长归用户 / 书是内容层 / 命题线是桥。
// 这里守三件事：① 存量单书用户读出来跟以前一模一样；② 灯表在内容层、未知书显式报错
// （V0.2 B4；第二本书的行为在 lamps.test.ts 用内容 fixture 守）；③ 命题上的程度只增不减、跨书原话调得出来。

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

describe('灯按书索引（M11-A / docs/05 §4.6；V0.2 B4 起灯表在内容层）', () => {
  it('每盏灯都挂在一条命题线上——这是书与人之间的桥', () => {
    const table = getBookLamps(DEFAULT_BOOK_ID)!;
    for (const rules of Object.values(table)) {
      for (const rule of rules) expect(TOPICS).toContain(rule.topic);
    }
  });

  it('lampsFor 与内容层灯表逐项一致（同一真相，不另抄一份）', () => {
    const table = getBookLamps(DEFAULT_BOOK_ID)!;
    for (const [stage, rules] of Object.entries(table)) {
      expect(lampsFor(DEFAULT_BOOK_ID, Number(stage))).toEqual(rules);
    }
    expect(lampsFor(DEFAULT_BOOK_ID, 4)).toEqual([]);
  });

  it('未知的书显式报错——不静默回落 v1（拿别的书的标准判人是事故，红线 6）', () => {
    expect(() => lampsFor('no-such-book', 2)).toThrow(/no-such-book/);
  });

  it('灯亮之后落在命题上的程度：认知类=看见、行为类=换过做法、本段全亮=走完', () => {
    const cognitive = lampsFor(DEFAULT_BOOK_ID, 2).find((r) => !r.needsAction)!;
    const behavioral = lampsFor(DEFAULT_BOOK_ID, 2).find((r) => r.needsAction)!;
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


// ───────── 命题线的跨书语义 ─────────
// buildThreadBlock 不查内容层——bookId 只用来判断"这条原话是不是在别的书里说的"，
// 所以用一个内容层没听过的 id 也能把"上一本书"的标注语义守住。
// （换书时的**灯**怎么各判各的，在 lamps.test.ts 用内容 fixture 守。）
const OTHER_BOOK = 'a-book-the-content-layer-never-heard-of';

describe('换书时的命题线：程度和原话跟着人走', () => {
  it('第一本里攒下的程度与原话，在第二本的上下文里照样调得出来', () => {
    const block = buildThreadBlock(
      {
        'self-worth': {
          firstSeenAt: '2026-08-01T00:00:00Z',
          lastSeenAt: '2026-08-20T00:00:00Z',
          depth: 'mastered',
          evidence: [
            { at: '2026-08-20T00:00:00Z', bookId: DEFAULT_BOOK_ID, source: 'assessment', quote: '我不敢报那个价' },
          ],
        },
      },
      OTHER_BOOK,
    )!;
    expect(block).toContain('我不敢报那个价');
    expect(block).toContain('（上一本书里）'); // 标出处，但不当新话题重讲
    expect(block).toContain('走完');
    // 换书不退：第二本里这条命题的起点是 mastered，不是从头再来
    expect(mergeDepth('mastered', 'seen')).toBe('mastered');
  });
});

describe('每日一签：看过的全局去重（池子按书各出各的，跨书去重在 lamps.test.ts 用内容 fixture 守）', () => {
  it('整池都看过时兜底重发旧的，不报错、不空白、不凭空造新的', () => {
    const all = getDailyPool('zh-CN', DEFAULT_BOOK_ID).map((c) => c.text);
    const exhausted = pickDaily('zh-CN', '2026-10-01', 1, all, DEFAULT_BOOK_ID);
    expect(exhausted && all.includes(exhausted.text)).toBe(true);
  });
});

// ───────── 接线：不传 bookId 的存量调用点行为一模一样 ─────────
// V0.2 B4 起段数与灯表都从内容层来、未知书显式报错（不再回落 v1）；
// "传了别的书就按那本书算"的用例在 lamps.test.ts 的内容 fixture 里。
describe('段数与灯跟着书走（M11-A 接线）', () => {
  const p = (over: Partial<GrowthProfile> = {}): GrowthProfile =>
    ({
      user_key: 'u:books-test',
      locale: 'zh-CN',
      portrait: null,
      concerns: [],
      stage: 1,
      stage_started_at: '2026-09-01T00:00:00Z',
      pinned: [],
      memories: [],
      experiments: [],
      letters: [],
      stamps: [],
      evolution: { dismissedAt: null, lastGeneratedAt: null, proposedSeenAt: null, generatingAt: null },
      assessment: {
        pending: null,
        confirmed: null,
        confirmedAt: null,
        dismissedAt: null,
        generatingAt: null,
        proposedSeenAt: null,
      },
      created_at: '2026-08-01T00:00:00Z',
      dailySeen: [],
      payday: null,
      total_active_days: 0,
      last_active_date: null,
      books: [],
      threads: {},
      touch: {},
      ...over,
    }) as GrowthProfile;

  it('段数属于书：v1 是 4 段，不认识的书是 0（调用方自己决定回落）', () => {
    expect(stageCountFor(DEFAULT_BOOK_ID)).toBe(4);
    expect(stageCountFor()).toBe(stageCountFor(DEFAULT_BOOK_ID));
    expect(stageCountFor('no-such-book')).toBe(0);
    // 段数和内容层是同一个真相，不另写一份常量
    expect(stageCountFor(DEFAULT_BOOK_ID)).toBe(getJourneyStages('zh-CN', DEFAULT_BOOK_ID).length);
  });

  it('不传 bookId = v1 那本书：存量调用点零行为变化', () => {
    const profile = p();
    expect(computeStageProgress('zh-CN', 1, profile)).toEqual(computeStageProgress('zh-CN', 1, profile, DEFAULT_BOOK_ID));
    expect(stageLampScales(profile)).toEqual(stageLampScales(profile, DEFAULT_BOOK_ID));
    expect(stageAdvanceTarget(profile)).toBe(stageAdvanceTarget(profile, DEFAULT_BOOK_ID));
    expect(actionEvidenceKinds(1)).toEqual(actionEvidenceKinds(1, DEFAULT_BOOK_ID));
  });
});
