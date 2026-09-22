// 起草后台任务端点（2026-09-22）：POST 立刻回 jobId（任务进程内续跑），
// GET ?id= 轮询进度。running 时不带 state（轮询包很小），结束才带整份工作台态。
// confirm（2026-09-23 管理员确认闸）：前端探针识别 + 管理员点确认后的载荷，
// 形状不对就 400——known!==true 的「确认」不算确认，无素材起草仍会被服务端闸拦。
import { requireApiAdmin } from '@/lib/admin-auth';
import { readAdminBook } from '@/lib/admin-content';
import { findRunningDraftJob, getDraftJob, startDraftJob } from '@/lib/admin-draft-job';
import type { BookRecognition } from '@/lib/admin-recognize';

export async function POST(request: Request) {
  const gate = await requireApiAdmin();
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as
    | { bookId?: string; kind?: string; source?: string; confirm?: unknown }
    | null;
  const bookId = String(body?.bookId ?? '');
  const kind = body?.kind === 'daily' ? 'daily' : body?.kind === 'all' ? 'all' : 'journey';

  // confirm 形状校验：必须对象且 known===true（探针 known:false 时前端根本不该发请求）
  let confirm: BookRecognition | undefined;
  if (body?.confirm !== undefined) {
    const c = body.confirm as Partial<BookRecognition>;
    if (typeof body.confirm !== 'object' || body.confirm === null || c.known !== true) {
      return Response.json({ ok: false, error: 'invalid_confirm' }, { status: 400 });
    }
    const s = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
    confirm = { known: true, title: s(c.title), author: s(c.author), coreMethod: s(c.coreMethod), note: s(c.note) };
  }

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
    confirm,
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
