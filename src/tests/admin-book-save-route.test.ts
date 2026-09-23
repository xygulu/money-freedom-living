// 工作台保存路由测试：默认整份写回；scope:'meta' 只把 meta 写回盘（素材/草稿区块
// 保持磁盘现状——表单里那些可能是没写完的现场编辑，不该被保存书信息顺手带走）。
// admin 门 mock 掉（requireApiAdmin 真身读 next/headers，node 环境会炸）；
// readAdminBook/writeAdminBook mock 掉（不落真实临时目录，断言调用参数），
// validateSaveShape 用真身（形状校验本身是被测行为）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminBookState } from '@/lib/admin-content';

vi.mock('@/lib/admin-auth', () => ({
  requireApiAdmin: vi.fn(async () => ({ ok: true, email: 'a@b.c' })),
}));

vi.mock('@/lib/admin-content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-content')>();
  return { ...actual, readAdminBook: vi.fn(), writeAdminBook: vi.fn() };
});

import { POST } from '@/app/api/admin/books/[bookId]/save/route';
import { requireApiAdmin } from '@/lib/admin-auth';
import { readAdminBook, writeAdminBook } from '@/lib/admin-content';

const gateMock = vi.mocked(requireApiAdmin);
const readMock = vi.mocked(readAdminBook);
const writeMock = vi.mocked(writeAdminBook);

/** 磁盘现状：meta 还是 TODO 作者，journey 已有一段（草稿产物） */
const diskState = {
  meta: { id: 'test-book', title: { 'zh-CN': '测试之书' }, author: '', source: '', topics: [], status: 'draft', note: '' },
  source: '磁盘素材',
  journey: { 'zh-CN': [{ id: 1, body: '磁盘正文' }] },
  lamps: {},
  daily: { 'zh-CN': [], en: [] },
} as unknown as AdminBookState;

/** 表单载荷：meta 已填真实作者，journey 是写了一半的现场编辑（不该被 meta 保存带走） */
const formState = (over: Record<string, unknown> = {}) =>
  ({
    meta: { id: 'test-book', title: { 'zh-CN': '测试之书' }, author: '真实作者', source: '某某出版社 2024', topics: ['self-worth'], status: 'draft', note: '一句话' },
    source: '写了一半的素材',
    journey: { 'zh-CN': [{ id: 1, body: '写了一半' }] },
    lamps: {},
    daily: { 'zh-CN': [], en: [] },
    ...over,
  }) as unknown as AdminBookState;

const req = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  gateMock.mockResolvedValue({ ok: true, email: 'a@b.c' });
  readMock.mockReset();
  writeMock.mockReset();
  readMock.mockReturnValue(diskState);
});

async function call(body: unknown): Promise<Response> {
  return (await POST(req(body), { params: Promise.resolve({ bookId: 'test-book' }) })) as Response;
}

describe('POST /api/admin/books/[bookId]/save', () => {
  it('admin 门不过 → 原样返回门响应，不触盘', async () => {
    const denial = Response.json({ error: 'forbidden' }, { status: 403 });
    gateMock.mockResolvedValueOnce({ ok: false, response: denial });
    const res = await call({ state: formState() });
    expect(res.status).toBe(403);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('无 scope：整份状态写回（既有行为不变）', async () => {
    const state = formState();
    const res = await call({ state });
    expect(res.status).toBe(200);
    expect(writeMock).toHaveBeenCalledWith('test-book', state);
  });

  it("scope:'meta'：只把 meta 写回盘，journey/source 保持磁盘现状", async () => {
    const res = await call({ scope: 'meta', state: formState() });
    expect(res.status).toBe(200);
    expect(writeMock).toHaveBeenCalledTimes(1);
    const [, written] = writeMock.mock.calls[0]!;
    expect(written.meta.author).toBe('真实作者');
    expect(written.meta.source).toBe('某某出版社 2024');
    expect(written.journey).toBe(diskState.journey); // 磁盘对象原样，不是表单里的半成品
    expect(written.source).toBe('磁盘素材');
  });

  it("scope:'meta' + 书不在盘上 → 404 book_not_found，不写", async () => {
    readMock.mockReturnValue(null);
    const res = await call({ scope: 'meta', state: formState() });
    expect(res.status).toBe(404);
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('形状垃圾（status 非法）→ 400 invalid_state，两种 scope 都不写', async () => {
    for (const body of [
      { state: formState({ meta: { status: 'online' } }) },
      { scope: 'meta', state: formState({ meta: { status: 'online' } }) },
    ]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      const data = (await (res as Response).json()) as { error?: string; log?: string[] };
      expect(data.error).toBe('invalid_state');
      expect(data.log?.join()).toContain('meta.status');
    }
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('writeAdminBook 抛错（书目录缺失等）→ 500 write_failed', async () => {
    writeMock.mockImplementation(() => {
      throw new Error('书不存在：test-book');
    });
    const res = await call({ state: formState() });
    expect(res.status).toBe(500);
    const data = (await (res as Response).json()) as { error?: string };
    expect(data.error).toBe('write_failed');
  });
});
