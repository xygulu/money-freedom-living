// C5（2026-09-24）：换书场景的画像版本归属——select 模式真的换了主线书时，
// 先把当前画像存一版 source='book_switch'、book_id 归出走的书。
// 路由薄壳：身份/落库/埋点/版本表 mock 掉，判定逻辑（换没换 / 有没有画像 / add 不触发）在这里守。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bookOverrides = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@/lib/identity', () => ({
  resolveIdentity: vi.fn(async () => ({ key: 'u:switch-test', newGuestCookie: null })),
}));

vi.mock('@/lib/analytics', () => ({
  track: vi.fn(async () => undefined),
}));

vi.mock('@/lib/profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/profile')>();
  return {
    ...actual,
    ensureProfile: vi.fn(),
    saveBooks: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/evolution', () => ({
  insertPortraitVersion: vi.fn(async () => undefined),
  nextPortraitVersion: vi.fn(async () => 3),
}));

vi.mock('@/lib/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/content')>();
  type Meta = ReturnType<typeof actual.getBook>;
  return {
    ...actual,
    getBook: (id: string): Meta => (bookOverrides.get(id) as Meta) ?? actual.getBook(id),
  };
});

import { POST } from '@/app/api/me/books/route';
import { ensureProfile, saveBooks, type BookEntry, type GrowthProfile } from '@/lib/profile';
import { insertPortraitVersion } from '@/lib/evolution';
import { track } from '@/lib/analytics';

const entry = (bookId: string, status: BookEntry['status'], extra: Partial<BookEntry> = {}): BookEntry => ({
  bookId,
  status,
  startedAt: '2026-09-01T00:00:00.000Z',
  stage: 2,
  stageStartedAt: '2026-09-02T00:00:00.000Z',
  ...extra,
});

const portrait = { version: 2, spoken: [], baseColor: '', moments: [], script: '', toFuture: '', calibrations: [], scriptStatus: 'pending' };

const profileWith = (books: BookEntry[], withPortrait: boolean): Partial<GrowthProfile> => ({
  books,
  locale: 'zh-CN',
  ...(withPortrait ? { portrait: portrait as GrowthProfile['portrait'] } : {}),
});

const req = (body: unknown) => ({ json: async () => body } as never);

beforeEach(() => {
  bookOverrides.clear();
  bookOverrides.set('book-b', { id: 'book-b', title: { en: 'book-b' }, status: 'active', topics: ['parents'], author: '', source: '', note: '' });
  vi.mocked(insertPortraitVersion).mockClear();
  vi.mocked(saveBooks).mockClear();
  vi.mocked(track).mockClear();
});

describe('换书快照（C5 book_switch）', () => {
  it('select 换了主线书 + 已有画像 → 快照归出走的书', async () => {
    vi.mocked(ensureProfile).mockResolvedValue(profileWith([entry('money-freedom', 'active')], true) as GrowthProfile);
    const res = await POST(req({ bookId: 'book-b', mode: 'select', locale: 'zh-CN' }));
    expect(res.status).toBe(200);
    expect(insertPortraitVersion).toHaveBeenCalledTimes(1);
    const [userKey, version, snap, source, material, bookId] = vi.mocked(insertPortraitVersion).mock.calls[0];
    expect(userKey).toBe('u:switch-test');
    expect(version).toBe(3);
    expect(source).toBe('book_switch');
    expect(bookId).toBe('money-freedom'); // 归出走的书，不是新书
    expect(material).toEqual({ from: 'money-freedom', to: 'book-b' });
    expect((snap as { version: number }).version).toBe(2); // 快照 = 换书那一刻的现画像
  });

  it('select 同一本书（重选）→ 不快照', async () => {
    vi.mocked(ensureProfile).mockResolvedValue(profileWith([entry('money-freedom', 'active')], true) as GrowthProfile);
    await POST(req({ bookId: 'money-freedom', mode: 'select', locale: 'zh-CN' }));
    expect(insertPortraitVersion).not.toHaveBeenCalled();
  });

  it('add 模式（汇入制）不换主线 → 不快照', async () => {
    vi.mocked(ensureProfile).mockResolvedValue(profileWith([entry('money-freedom', 'active')], true) as GrowthProfile);
    await POST(req({ bookId: 'book-b', mode: 'add', locale: 'zh-CN' }));
    expect(insertPortraitVersion).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith('u:switch-test', 'book_added', expect.anything(), 'zh-CN');
  });

  it('换了书但还没有画像 → 不快照（没东西可归属）', async () => {
    vi.mocked(ensureProfile).mockResolvedValue(profileWith([entry('money-freedom', 'active')], false) as GrowthProfile);
    await POST(req({ bookId: 'book-b', mode: 'select', locale: 'zh-CN' }));
    expect(insertPortraitVersion).not.toHaveBeenCalled();
  });

  it('快照失败不拦选书（best-effort）', async () => {
    vi.mocked(ensureProfile).mockResolvedValue(profileWith([entry('money-freedom', 'active')], true) as GrowthProfile);
    vi.mocked(insertPortraitVersion).mockRejectedValueOnce(new Error('db down'));
    const res = await POST(req({ bookId: 'book-b', mode: 'select', locale: 'zh-CN' }));
    expect(res.status).toBe(200);
    expect(saveBooks).toHaveBeenCalledTimes(1);
  });
});
