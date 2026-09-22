// draft-job 路由测试：confirm 形状校验与透传（2026-09-23 管理员确认闸）。
// 门/读盘/任务启动全 mock——只守「confirm 怎么校验、合法载荷怎么进 startDraftJob」。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminBookState } from '@/lib/admin-content';

vi.mock('@/lib/admin-auth', () => ({
  requireApiAdmin: vi.fn(async () => ({ ok: true, email: 'a@b.c' })),
}));

vi.mock('@/lib/admin-content', () => ({
  readAdminBook: vi.fn(),
}));

vi.mock('@/lib/admin-draft-job', () => ({
  findRunningDraftJob: vi.fn(() => null),
  getDraftJob: vi.fn(),
  startDraftJob: vi.fn(),
}));

import { POST } from '@/app/api/admin/draft-job/route';
import { requireApiAdmin } from '@/lib/admin-auth';
import { readAdminBook } from '@/lib/admin-content';
import { startDraftJob } from '@/lib/admin-draft-job';

const gateMock = vi.mocked(requireApiAdmin);
const readMock = vi.mocked(readAdminBook);
const startMock = vi.mocked(startDraftJob);

const draftState = {
  meta: { status: 'draft', title: { 'zh-CN': '测试之书' }, author: '某人' },
  source: '',
} as unknown as AdminBookState;

const req = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  gateMock.mockResolvedValue({ ok: true, email: 'a@b.c' });
  readMock.mockReturnValue(draftState);
  startMock.mockReset();
  startMock.mockReturnValue({ id: 'j1' } as ReturnType<typeof startDraftJob>);
});

async function call(body: unknown): Promise<Response> {
  return (await POST(req(body))) as Response;
}

describe('POST /api/admin/draft-job confirm 校验（2026-09-23 确认闸）', () => {
  it('不带 confirm → startDraftJob 收到 undefined（服务端识别闸兜底的旧语义）', async () => {
    const res = await call({ bookId: 'test-book', kind: 'daily' });
    expect(res.status).toBe(200);
    expect(startMock.mock.calls[0]?.[0]?.confirm).toBeUndefined();
  });

  it('合法 confirm（对象且 known===true）→ trim 后原样透传', async () => {
    const res = await call({
      bookId: 'test-book',
      kind: 'daily',
      confirm: { known: true, title: ' 测试之书 ', author: ' 某人 ', coreMethod: ' 金钱心理 ', note: '' },
    });
    expect(res.status).toBe(200);
    expect(startMock.mock.calls[0]?.[0]?.confirm).toEqual({
      known: true,
      title: '测试之书',
      author: '某人',
      coreMethod: '金钱心理',
      note: '',
    });
  });

  it('confirm 非对象 / known!==true → 400 invalid_confirm，任务不启动', async () => {
    for (const confirm of ['yes', 1, { known: false }, null]) {
      const res = await call({ bookId: 'test-book', confirm });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_confirm');
    }
    expect(startMock).not.toHaveBeenCalled();
  });
});
