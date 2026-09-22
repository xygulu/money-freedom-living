// V0.2 批 A（docs/02 §20.1）：入口选书——选书落库纯函数 + 愿望 + A1 落地页身份拆分判据。
// 路由（/api/me/books、/api/me/wishes）是薄壳，核心语义都在纯函数里守。
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import zhCN from '@/i18n/messages/zh-CN.json';
import zhTW from '@/i18n/messages/zh-TW.json';
import ja from '@/i18n/messages/ja.json';
import { TOPICS, DEFAULT_BOOK_ID, getBooks } from '@/lib/content';
import {
  activeBook,
  activeBookEntries,
  activeBookId,
  addBookSelection,
  appendWish,
  mainBookEntry,
  mainBookId,
  mergeBookSelection,
  parseBooks,
  parseWishedBooks,
  type BookEntry,
  type WishEntry,
} from '@/lib/profile';

const NOW = '2026-09-21T05:00:00.000Z';

const entry = (bookId: string, status: BookEntry['status'], extra: Partial<BookEntry> = {}): BookEntry => ({
  bookId,
  status,
  startedAt: '2026-09-01T00:00:00.000Z',
  stage: 2,
  stageStartedAt: '2026-09-02T00:00:00.000Z',
  ...extra,
});

describe('mergeBookSelection（A3：选书落库）', () => {
  it('空档案选书：单条 active，startedAt 从现在起算', () => {
    const books = mergeBookSelection([], 'money-freedom', NOW);
    expect(books).toEqual([
      { bookId: 'money-freedom', status: 'active', startedAt: NOW, stage: 1, stageStartedAt: NOW },
    ]);
  });

  it('换书：目标 active，原当前书 paused；各自的 startedAt 都保留', () => {
    const books = mergeBookSelection([entry('book-a', 'active'), entry('book-b', 'paused')], 'book-b', NOW);
    expect(books.find((b) => b.bookId === 'book-b')?.status).toBe('active');
    expect(books.find((b) => b.bookId === 'book-a')?.status).toBe('paused');
    expect(books.find((b) => b.bookId === 'book-a')?.startedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('done 保留（读过的书不因换书变成「没读过」）', () => {
    const books = mergeBookSelection([entry('book-a', 'active'), entry('book-c', 'done', { finishedAt: '2026-09-10T00:00:00.000Z' })], 'book-b', NOW);
    expect(books.find((b) => b.bookId === 'book-c')).toMatchObject({ status: 'done', finishedAt: '2026-09-10T00:00:00.000Z' });
  });

  it('重选 done 的书 = 重读：active、清 finishedAt、startedAt 重新起算', () => {
    const books = mergeBookSelection([entry('book-c', 'done', { finishedAt: '2026-09-10T00:00:00.000Z' })], 'book-c', NOW);
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ status: 'active', startedAt: NOW });
    expect(books[0]?.finishedAt).toBeUndefined();
  });

  it('重复选同一本不产生重复条目', () => {
    const once = mergeBookSelection([], 'book-a', NOW);
    const twice = mergeBookSelection(once, 'book-a', NOW);
    expect(twice).toHaveLength(1);
    expect(twice[0]?.startedAt).toBe(NOW); // 还是同一次阅读，起点不刷新
  });
});

describe('appendWish / parseWishedBooks（A4：不在册书的愿望）', () => {
  it('追加一条 {title, at}', () => {
    const wishes = appendWish([], '一本书', NOW);
    expect(wishes).toEqual([{ title: '一本书', at: NOW }]);
  });

  it('同名去重（不重复记）', () => {
    const once = appendWish([], '一本书', NOW);
    expect(appendWish(once, '一本书', NOW)).toEqual(once);
    expect(appendWish(once, ' 一本书 ', NOW)).toEqual(once); // trim 后同名也不重复
  });

  it('封顶 50 条（防灌水），留最新的', () => {
    let wishes: WishEntry[] = [];
    for (let i = 0; i < 55; i++) wishes = appendWish(wishes, `书 ${i}`, NOW);
    expect(wishes).toHaveLength(50);
    expect(wishes[0]?.title).toBe('书 5');
    expect(wishes[49]?.title).toBe('书 54');
  });

  it('空串不追加', () => {
    expect(appendWish([], '   ', NOW)).toEqual([]);
  });

  it('老档案无该字段 / 坏数据读出空数组，不报错（B2 同款口径）', () => {
    expect(parseWishedBooks(undefined)).toEqual([]);
    expect(parseWishedBooks('nope')).toEqual([]);
    expect(parseWishedBooks([{ title: 'x' }, null, { title: 'y', at: NOW }])).toEqual([{ title: 'y', at: NOW }]);
  });
});

describe('focusTopic（V0.2 B2：焦点命题，老档案无该字段读出不报错）', () => {
  it('mergeBookSelection 带 focusTopic：落到目标书条目', () => {
    const books = mergeBookSelection([], 'money-freedom', NOW, 'parents');
    expect(books[0]?.focusTopic).toBe('parents');
  });

  it('不带 focusTopic 重选：保留该书已有的焦点（重选不清空）', () => {
    const once = mergeBookSelection([], 'money-freedom', NOW, 'parents');
    const twice = mergeBookSelection(once, 'money-freedom', NOW);
    expect(twice[0]?.focusTopic).toBe('parents');
  });

  it('换书后回到原书：焦点跟着书条目走', () => {
    const withFocus = mergeBookSelection([], 'book-a', NOW, 'parents');
    const switched = mergeBookSelection(withFocus, 'book-b', NOW);
    expect(switched.find((b) => b.bookId === 'book-a')?.status).toBe('paused');
    expect(switched.find((b) => b.bookId === 'book-a')?.focusTopic).toBe('parents');
    const back = mergeBookSelection(switched, 'book-a', NOW);
    expect(back.find((b) => b.bookId === 'book-a')?.focusTopic).toBe('parents');
  });

  it('parseBooks：老档案无 focusTopic 读出 undefined，不凭空补字段', () => {
    const books = parseBooks(
      [{ bookId: 'money-freedom', status: 'active', startedAt: NOW, stage: 1, stageStartedAt: NOW }],
      1,
      NOW,
      NOW,
    );
    expect(books[0]?.focusTopic).toBeUndefined();
  });

  it('parseBooks：非法 focusTopic（不在六命题）丢弃；合法的保留', () => {
    const bad = parseBooks(
      [{ bookId: 'money-freedom', status: 'active', startedAt: NOW, stage: 1, stageStartedAt: NOW, focusTopic: 'not-a-topic' as BookEntry['focusTopic'] }],
      1,
      NOW,
      NOW,
    );
    expect(bad[0]?.focusTopic).toBeUndefined();
    const good = parseBooks(
      [{ bookId: 'money-freedom', status: 'active', startedAt: NOW, stage: 1, stageStartedAt: NOW, focusTopic: 'parents' }],
      1,
      NOW,
      NOW,
    );
    expect(good[0]?.focusTopic).toBe('parents');
  });
});

describe('addBookSelection（V0.2 批 C：汇入制加书）', () => {
  it('全新加书：末尾插入 active、stage 1；**已有 active 一律不被暂停**（头条案例）', () => {
    const existing = [entry('money-freedom', 'active'), entry('book-a', 'paused')];
    const books = addBookSelection(existing, 'book-b', NOW);
    expect(books).toHaveLength(3);
    expect(books[2]).toEqual({
      bookId: 'book-b',
      status: 'active',
      startedAt: NOW,
      stage: 1,
      stageStartedAt: NOW,
    });
    // 汇入制核心：别人的 status/startedAt/stage 原样
    expect(books[0]).toEqual(entry('money-freedom', 'active'));
    expect(books[1]).toEqual(entry('book-a', 'paused'));
  });

  it('暂停的书重新加回：恢复 active，startedAt/stage/stageStartedAt 全保留', () => {
    const existing = [
      entry('book-a', 'paused', { startedAt: '2026-08-01T00:00:00.000Z', stage: 3, stageStartedAt: '2026-08-20T00:00:00.000Z' }),
      entry('money-freedom', 'active'),
    ];
    const books = addBookSelection(existing, 'book-a', NOW);
    expect(books.find((b) => b.bookId === 'book-a')).toEqual({
      bookId: 'book-a',
      status: 'active',
      startedAt: '2026-08-01T00:00:00.000Z',
      stage: 3,
      stageStartedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(books.find((b) => b.bookId === 'money-freedom')?.status).toBe('active');
  });

  it('done 的书再加 = 重读：active、清 finishedAt、startedAt 重新起算', () => {
    const existing = [entry('book-c', 'done', { finishedAt: '2026-09-10T00:00:00.000Z' })];
    const books = addBookSelection(existing, 'book-c', NOW);
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ status: 'active', startedAt: NOW });
    expect(books[0]?.finishedAt).toBeUndefined();
  });

  it('重复加已是 active 的书：no-op（同一数组原样返回），不 bump startedAt', () => {
    const existing = [entry('money-freedom', 'active'), entry('book-b', 'active', { startedAt: NOW })];
    expect(addBookSelection(existing, 'book-b', '2026-09-22T00:00:00.000Z')).toBe(existing);
    expect(existing.find((b) => b.bookId === 'book-b')?.startedAt).toBe(NOW);
  });

  it('focusTopic：加书时带上；恢复/重读时不带则沿用已有的；active 时传新的则更新', () => {
    const added = addBookSelection([], 'book-b', NOW, 'parents');
    expect(added[0]?.focusTopic).toBe('parents');
    const paused = addBookSelection([{ ...added[0]!, status: 'paused' as const }], 'book-b', NOW);
    expect(paused[0]?.focusTopic).toBe('parents');
    const arr = [added[0]!];
    expect(addBookSelection(arr, 'book-b', NOW)).toBe(arr); // active 且无新焦点 → 原样 no-op
    const updated = addBookSelection(arr, 'book-b', NOW, 'allowing');
    expect(updated[0]?.focusTopic).toBe('allowing');
  });
});

describe('parseBooks 行级真源覆盖（V0.2 批 C：两本 active 时覆盖主线）', () => {
  it('数组序第一个 active 不是主线时，行级 stage 落到最早 startedAt 的那条', () => {
    // 故意让数组序在前的那本 startedAt 更晚（加书是末尾插入，但坏序数据也要对）
    const books = parseBooks(
      [
        { bookId: 'book-b', status: 'active', startedAt: '2026-09-20T00:00:00.000Z', stage: 1, stageStartedAt: NOW },
        { bookId: 'money-freedom', status: 'active', startedAt: '2026-09-01T00:00:00.000Z', stage: 1, stageStartedAt: NOW },
      ],
      3,
      '2026-09-15T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    );
    expect(books.find((b) => b.bookId === 'money-freedom')).toMatchObject({ stage: 3, stageStartedAt: '2026-09-15T00:00:00.000Z' });
    expect(books.find((b) => b.bookId === 'book-b')).toMatchObject({ stage: 1, stageStartedAt: NOW }); // 非主线不被覆盖
  });
});

describe('mainBook helpers（V0.2 批 C：主线 = 最早 startedAt 的 active）', () => {
  const profileOf = (books: BookEntry[]) => ({ books });

  it('activeBookEntries 按 startedAt 升序；平局保持数组序', () => {
    const books = [
      entry('book-b', 'active', { startedAt: '2026-09-20T00:00:00.000Z' }),
      entry('book-a', 'active', { startedAt: '2026-09-01T00:00:00.000Z' }),
      entry('book-c', 'paused'),
      entry('book-d', 'active', { startedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(activeBookEntries(profileOf(books)).map((b) => b.bookId)).toEqual(['book-a', 'book-d', 'book-b']);
  });

  it('mainBookId：空/无 active 回落 v1 书；activeBookId === mainBookId；activeBook === mainBookEntry', () => {
    expect(mainBookId(profileOf([]))).toBe(DEFAULT_BOOK_ID);
    expect(mainBookId(profileOf([entry('book-a', 'paused')]))).toBe(DEFAULT_BOOK_ID);
    const books = [entry('book-b', 'active', { startedAt: '2026-09-20T00:00:00.000Z' }), entry('book-a', 'active')];
    const profile = profileOf(books);
    expect(mainBookId(profile)).toBe('book-a');
    expect(activeBookId(profile)).toBe('book-a');
    expect(activeBook(profile)).toEqual(mainBookEntry(profile));
    expect(mainBookEntry(profile)?.bookId).toBe('book-a');
  });
});


describe('B1 判据：选命题屏', () => {
  it('四语 onboarding.topic 键齐全且同构', () => {
    const dicts = [en, zhCN, zhTW, ja] as { onboarding: { topic: Record<string, string> } }[];
    for (const key of ['title', 'hint', 'none']) {
      for (const d of dicts) {
        expect(typeof d.onboarding.topic[key], `onboarding.topic.${key} 缺`).toBe('string');
        expect((d.onboarding.topic[key] ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('命题用户文案真源 dict.topics：四语六命题齐全（TOPICS_ZH 是 prompt 备注，不进 UI）', () => {
    const dicts = [en, zhCN, zhTW, ja] as { topics: Record<string, string> }[];
    for (const t of TOPICS) {
      for (const d of dicts) {
        expect(typeof d.topics[t], `topics.${t} 缺`).toBe('string');
        expect((d.topics[t] ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('在册书的 topics 非空且都是合法命题（选命题选项来自本书 topics）', () => {
    for (const b of getBooks()) {
      if (b.status !== 'active') continue;
      expect(b.topics.length, `${b.id} topics 为空`).toBeGreaterThan(0);
      for (const t of b.topics) expect(TOPICS, `${b.id} 带非法命题 ${t}`).toContain(t);
    }
  });
});

describe('A1 判据：落地页主文案不再是书名', () => {
  it('4 语 landing.hero ≠ 任何在册书的任何语言书名', () => {
    const titles = new Set<string>();
    for (const b of getBooks()) {
      for (const t of Object.values(b.title)) titles.add(t.trim());
    }
    expect(titles.size).toBeGreaterThan(0);
    const dicts = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja } as Record<string, { landing: { hero: string } }>;
    for (const [locale, dict] of Object.entries(dicts)) {
      expect(titles.has(dict.landing.hero.trim()), `${locale} landing.hero 仍是书名`).toBe(false);
    }
  });

  it('选书屏文案四语同构（A2 新键齐全）', () => {
    const dicts = [en, zhCN, zhTW, ja] as { onboarding: { book: Record<string, string> } }[];
    for (const key of ['title', 'hint', 'selected', 'mine', 'minePlaceholder', 'mineSubmit', 'wishReply', 'next']) {
      for (const d of dicts) {
        expect(typeof d.onboarding.book[key], `onboarding.book.${key} 缺`).toBe('string');
        expect((d.onboarding.book[key] ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('加书入口文案四语同构（V0.2 批 C：addBook.* 键齐全）', () => {
    const dicts = [en, zhCN, zhTW, ja] as { addBook: Record<string, string> }[];
    for (const key of ['entry', 'close', 'topicsLead', 'confirm', 'added']) {
      for (const d of dicts) {
        expect(typeof d.addBook[key], `addBook.${key} 缺`).toBe('string');
        expect((d.addBook[key] ?? '').length).toBeGreaterThan(0);
      }
    }
  });
});
