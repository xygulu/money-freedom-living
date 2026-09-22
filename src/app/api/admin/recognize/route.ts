// 识别探针（2026-09-23 管理员确认闸，前半步）：生成前先问 AI「你找到的是哪本书」，
// 结果作为数据回给前端弹确认卡——管理员确认后才 POST draft-job 真正生成。
// known:false 是有效结论，走 200 数据（不是错误）：拒绝是结论，不是故障。
// 不启动任务、不写盘。守卫镜像 draft-job（bad_book_id / book_not_found / book_is_active）；
// 故意不查 job_running——探针只读无写盘冲突，确认点击时 draft-job 自会 409。
import { requireApiAdmin } from '@/lib/admin-auth';
import { readAdminBook } from '@/lib/admin-content';
import { recognizeBook } from '@/lib/admin-recognize';

export async function POST(request: Request) {
  const gate = await requireApiAdmin();
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as { bookId?: string; source?: string } | null;
  const bookId = String(body?.bookId ?? '');
  if (!bookId || bookId.includes('..') || bookId.includes('/')) {
    return Response.json({ ok: false, error: 'bad_book_id' }, { status: 400 });
  }

  const state = readAdminBook(bookId);
  if (!state) return Response.json({ ok: false, error: 'book_not_found' }, { status: 404 });
  if (state.meta.status === 'active') {
    return Response.json(
      { ok: false, error: 'book_is_active', log: ['这本书是 active：AI 不许覆盖线上内容，起草被拒（打标不受限）。'] },
      { status: 409 },
    );
  }

  // 与 runDraftStep 同一表达式：素材 ≥50 字符时生成本就不走识别闸，探针直接放行
  const material = typeof body?.source === 'string' && body.source.trim() ? body.source : state.source;
  if (material.trim().length >= 50) {
    return Response.json({ ok: true, skipped: true });
  }

  const recognition = await recognizeBook(state.meta.title['zh-CN'] || bookId, state.meta.author, gate.email);
  return Response.json({ ok: true, recognition });
}
