// 起草后台任务端点（2026-09-22）：POST 立刻回 jobId（任务进程内续跑），
// GET ?id= 轮询进度。running 时不带 state（轮询包很小），结束才带整份工作台态。
import { requireApiAdmin } from '@/lib/admin-auth';
import { readAdminBook } from '@/lib/admin-content';
import { findRunningDraftJob, getDraftJob, startDraftJob } from '@/lib/admin-draft-job';

export async function POST(request: Request) {
  const gate = await requireApiAdmin();
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as { bookId?: string; kind?: string; source?: string } | null;
  const bookId = String(body?.bookId ?? '');
  const kind = body?.kind === 'daily' ? 'daily' : body?.kind === 'all' ? 'all' : 'journey';
  if (!bookId || bookId.includes('..') || bookId.includes('/')) {
    return Response.json({ ok: false, error: 'bad_book_id' }, { status: 400 });
  }

  const state = readAdminBook(bookId);
  if (!state) return Response.json({ ok: false, error: 'book_not_found' }, { status: 404 });
  if (state.meta.status === 'active') {
    return Response.json({ ok: false, error: 'book_is_active' }, { status: 409 });
  }
  const running = findRunningDraftJob(bookId);
  if (running) {
    return Response.json(
      { ok: false, error: 'job_running', jobId: running.id, log: ['这本书已有起草任务在跑——等它结束，或直接刷新页面看结果。'] },
      { status: 409 },
    );
  }

  const job = startDraftJob({
    bookId,
    kind,
    source: typeof body?.source === 'string' ? body.source : state.source,
    email: gate.email,
  });
  return Response.json({ ok: true, jobId: job.id });
}

export async function GET(request: Request) {
  const gate = await requireApiAdmin();
  if (!gate.ok) return gate.response;

  const id = new URL(request.url).searchParams.get('id') ?? '';
  const job = getDraftJob(id);
  if (!job) return Response.json({ ok: false, error: 'job_not_found' }, { status: 404 });
  return Response.json({
    ok: true,
    jobId: job.id,
    bookId: job.bookId,
    kind: job.kind,
    status: job.status,
    log: job.log,
    error: job.error,
    // running 时 state 给 null：轮询响应保持很小，结束那次才带整份工作台态
    state: job.status === 'running' ? null : job.state,
  });
}
