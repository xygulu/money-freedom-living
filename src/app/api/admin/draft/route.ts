// AI 起草（同步端点，2026-09-22 起为薄壳）：守卫/识别闸/生成/写盘都在
// admin-draft-run.runDraftStep——与后台任务（draft-job）共用同一份执行体。
// 本端点保留给脚本/测试用；后台 UI 走 draft-job（长请求过 Cloudflare Tunnel 会被
// 100 秒空闲上限掐断，同步等待已不可行）。只允许对 status: draft 的书起草。
import { requireApiAdmin } from '@/lib/admin-auth';
import { runDraftStep } from '@/lib/admin-draft-run';

const STATUS_BY_ERROR: Record<string, number> = {
  book_not_found: 404,
  book_is_active: 409,
  book_unknown: 422,
  draft_invalid: 502,
  llm_failed: 502,
};

export async function POST(request: Request) {
  const gate = await requireApiAdmin();
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as { bookId?: string; source?: string; kind?: string } | null;
  const bookId = String(body?.bookId ?? '');
  const kind = body?.kind === 'daily' ? 'daily' : 'journey';
  if (!bookId || bookId.includes('..') || bookId.includes('/')) {
    return Response.json({ ok: false, error: 'bad_book_id' }, { status: 400 });
  }

  const result = await runDraftStep(bookId, kind, body?.source, gate.email);
  if (result.ok) return Response.json({ ok: true, log: result.log, state: result.state });
  return Response.json(
    { ok: false, error: result.error, stage: result.stage, log: result.log },
    { status: STATUS_BY_ERROR[result.error ?? 'llm_failed'] ?? 502 },
  );
}
