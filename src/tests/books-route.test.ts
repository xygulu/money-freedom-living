// V0.2 批 C：/api/me/books 的 mode 分派（汇入制加书 vs 替换制选书）。
// 路由是薄壳：身份/落库/埋点 mock 掉，mergeBookSelection/addBookSelection 跑真函数——
// 纯函数语义在 books-entry.test.ts 守，这里只守「mode 怎么分派、埋点怎么记、校验怎么拒」。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bookOverrides = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@/lib/identity', () => ({
  resolveIdentity: vi.fn(async () => ({ key: 'u:route-test', newGuestCookie: null })),
}));

vi.mock('@/lib/analytics', () => ({
  track: vi.fn(async () => undefined),
}));

// profile 只 mock 两个 IO 面（ensureProfile/saveBooks），纯函数用真身
vi.mock('@/lib/profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/profile')>();
  return {
    ...actual,
    ensureProfile: vi.fn(),
    saveBooks: vi.fn(async () => undefined),
  };
});

// getBook 允许单测覆写（draft 书等目录状态不依赖真内容包的现状），其余走真目录
vi.mock('@/lib/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/content')>();
  type Meta = ReturnType<typeof actual.getBook>;
  return {
    ...actual,
    getBook: (id: string): Meta => (bookOverrides.get(id) as Meta) ?? actual.getBook(id),
  };
});

import { POST } from '@/app/api/me/books/route';
import { getBook } from '@/lib/content';
import { ensureProfile, saveBooks, type BookEntry } from '@/lib/profile';
import { track } from '@/lib/analytics';

const entry = (bookId: string, status: BookEntry['status'], extra: Partial<BookEntry> = {}): BookEntry => ({
  bookId,
  status,
  startedAt: '2026-09-01T00:00:00.000Z',
  stage: 2,
  stageStartedAt: '2026-09-02T00:00:00.000Z',
  ...extra,
});

const req = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  bookOverrides.clear();
  bookOverrides.set('book-a', { id: 'book-a', title: { en: 'book-a' }, status: 'active', topics: ['parents'], author: '', source: '', note: '' });
  bookOverrides.set('book-draft', { id: 'book-draft', title: { en: 'book-draft' }, status: 'draft', topics: [], author: '', source: '', note: '' });
  vi.mocked(saveBooks).mockClear();
  vi.mocked(track).mockClear();
  vi.mocked(ensureProfile).mockResolvedValue({
    books: [entry('money-freedom', 'active'), entry('book-a', 'paused')],
    locale: 'zh-CN',
  } as never);
});

async function call(body: unknown): Promise<Response> {
  return (await POST(req(body))) as Response;
}

describe('POST /api/me/books mode 分派（V0.2 批 C）', () => {
  it('mode:add：目标书 active，**既有 active 不被暂停**；埋点记 book_added', async () => {
    const res = await call({ bookId: 'book-a', locale: 'zh-CN', mode: 'add' });
    expect(res.status).toBe(200);
    const saved = vi.mocked(saveBooks).mock.calls[0]?.[1] as BookEntry[];
    expect(saved.find((b) => b.bookId === 'book-a')?.status).toBe('active');
    expect(saved.find((b) => b.bookId === 'money-freedom')?.status).toBe('active'); // 汇入制核心
    expect(vi.mocked(track).mock.calls[0]?.[1]).toBe('book_added');
  });

  it('缺省 mode = 替换制（回归护栏）：其余 paused，埋点记 book_selected', async () => {
    const res = await call({ bookId: 'book-a', locale: 'zh-CN' }); // 不带 mode
    expect(res.status).toBe(200);
    const saved = vi.mocked(saveBooks).mock.calls[0]?.[1] as BookEntry[];
    expect(saved.find((b) => b.bookId === 'book-a')?.status).toBe('active');
    expect(saved.find((b) => b.bookId === 'money-freedom')?.status).toBe('paused'); // 与旧行为一致
    expect(vi.mocked(track).mock.calls[0]?.[1]).toBe('book_selected');
  });
});

describe('POST /api/me/books 校验（不变语义）', () => {
  it('不存在的书 → 400 unknown_book', async () => {
    const res = await call({ bookId: 'book-nope', locale: 'zh-CN' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unknown_book');
  });

  it('draft 书 → 400 unknown_book（红线 1：不陈列还没上线的书，更不可选）', async () => {
    const res = await call({ bookId: 'book-draft', locale: 'zh-CN', mode: 'add' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unknown_book');
  });

  it('focusTopic 非法（不在六命题 / 不属于本书）→ 400 invalid_topic', async () => {
    const bad1 = await call({ bookId: 'book-a', locale: 'zh-CN', focusTopic: 'not-a-topic' });
    expect(bad1.status).toBe(400);
    const bad2 = await call({ bookId: 'book-a', locale: 'zh-CN', focusTopic: 'money-safety' }); // book-a.topics 只有 parents
    expect(bad2.status).toBe(400);
  });

  it('mode=add 时带合法 focusTopic：落到目标条目，埋点 book_added 带 topic', async () => {
    const res = await call({ bookId: 'book-a', locale: 'zh-CN', mode: 'add', focusTopic: 'parents' });
    expect(res.status).toBe(200);
    const saved = vi.mocked(saveBooks).mock.calls[0]?.[1] as BookEntry[];
    expect(saved.find((b) => b.bookId === 'book-a')?.focusTopic).toBe('parents');
    expect(vi.mocked(track).mock.calls[0]?.[1]).toBe('book_added');
    expect(vi.mocked(track).mock.calls[0]?.[2]).toMatchObject({ bookId: 'book-a', topic: 'parents' });
  });
});
