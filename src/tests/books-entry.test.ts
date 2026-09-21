// V0.2 批 A（docs/02 §20.1）：入口选书——选书落库纯函数 + 愿望 + A1 落地页身份拆分判据。
// 路由（/api/me/books、/api/me/wishes）是薄壳，核心语义都在纯函数里守。
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import zhCN from '@/i18n/messages/zh-CN.json';
import zhTW from '@/i18n/messages/zh-TW.json';
import ja from '@/i18n/messages/ja.json';
import { getBooks } from '@/lib/content';
import { appendWish, mergeBookSelection, parseWishedBooks, type BookEntry, type WishEntry } from '@/lib/profile';

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
});
