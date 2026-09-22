// 识别探针路由测试（2026-09-23 管理员确认闸前半步）：生成前只识别不生成——
// known:false 是 200 数据不是错误；素材 ≥50 skipped；守卫镜像 draft-job。
// admin 门与读盘 mock 掉（requireApiAdmin 真身读 next/headers，node 环境会炸）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminBookState } from '@/lib/admin-content';

vi.mock('@/lib/admin-auth', () => ({
  requireApiAdmin: vi.fn(async () => ({ ok: true, email: 'a@b.c' })),
}));

vi.mock('@/lib/admin-content', () => ({
  readAdminBook: vi.fn(),
}));

vi.mock('@/lib/admin-recognize', () => ({
  recognizeBook: vi.fn(),
}));

import { POST } from '@/app/api/admin/recognize/route';
import { requireApiAdmin } from '@/lib/admin-auth';
import { readAdminBook } from '@/lib/admin-content';
import { recognizeBook } from '@/lib/admin-recognize';

const gateMock = vi.mocked(requireApiAdmin);
const readMock = vi.mocked(readAdminBook);
const recMock = vi.mocked(recognizeBook);

const state = (over: { status?: 'draft' | 'active'; source?: string } = {}) =>
  ({
    meta: { status: over.status ?? 'draft', title: { 'zh-CN': '测试之书' }, author: '某人' },
    source: over.source ?? '',
  }) as unknown as AdminBookState;

const req = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  gateMock.mockResolvedValue({ ok: true, email: 'a@b.c' });
  readMock.mockReset();
  recMock.mockReset();
  readMock.mockReturnValue(state());
});

async function call(body: unknown): Promise<Response> {
  return (await POST(req(body))) as Response;
}

describe('POST /api/admin/recognize（识别探针）', () => {
  it('admin 门不过 → 原样返回门响应，不触书', async () => {
    const denial = Response.json({ error: 'forbidden' }, { status: 403 });
    gateMock.mockResolvedValueOnce({ ok: false, response: denial });
    const res = await call({ bookId: 'test-book' });
    expect(res.status).toBe(403);
    expect(readMock).not.toHaveBeenCalled();
    expect(recMock).not.toHaveBeenCalled();
  });

  it('bookId 空 / 带 .. / 带 / → 400 bad_book_id', async () => {
    for (const bookId of ['', 'a/../b', 'a/b']) {
      const res = await call({ bookId });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('bad_book_id');
    }
  });

  it('书不存在 → 404 book_not_found', async () => {
    readMock.mockReturnValueOnce(null);
    const res = await call({ bookId: 'ghost' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('book_not_found');
  });

  it('active 书 → 409（AI 不覆盖线上内容），body 带 log 供前端就地渲染', async () => {
    readMock.mockReturnValueOnce(state({ status: 'active' }));
    const res = await call({ bookId: 'test-book' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { log?: string[] }).log?.join('')).toContain('active');
    expect(recMock).not.toHaveBeenCalled();
  });

  it('素材 ≥50（body.source 带上）→ skipped，不烧识别调用（素材路径本就不走闸）', async () => {
    const res = await call({ bookId: 'test-book', source: '素材'.repeat(40) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
    expect(recMock).not.toHaveBeenCalled();
  });

  it('素材 ≥50（回落 state.source）→ 同样 skipped', async () => {
    readMock.mockReturnValueOnce(state({ source: '书 摘 录'.repeat(20) }));
    const res = await call({ bookId: 'test-book' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { skipped?: boolean }).skipped).toBe(true);
  });

  it('无素材 → 识别一次；known:false 是 200 数据（拒绝是结论不是故障）', async () => {
    recMock.mockResolvedValueOnce({ known: false, title: '', author: '', coreMethod: '', note: '没听过' });
    const res = await call({ bookId: 'test-book' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; recognition?: { known: boolean } };
    expect(body.ok).toBe(true);
    expect(body.recognition?.known).toBe(false);
    expect(recMock).toHaveBeenCalledWith('测试之书', '某人', 'a@b.c'); // 书名/作者读自盘上 meta
  });
});
