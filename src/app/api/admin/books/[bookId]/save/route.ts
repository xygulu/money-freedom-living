// 工作台保存（V0.2 C4）：整份编辑态写回 content/books/<id>/ 源文件。
// 形状校验只拦「会把文件写坏」的垃圾；内容质量（量级/四语齐）由发布闸（C2）在发布时硬拦。
import { requireApiAdmin } from '@/lib/admin-auth';
import { validateSaveShape, writeAdminBook } from '@/lib/admin-content';

export async function POST(request: Request, ctx: { params: Promise<{ bookId: string }> }) {
  const gate = await requireApiAdmin();
  if (!gate.ok) return gate.response;

  const { bookId } = await ctx.params;
  if (!bookId || bookId.includes('..') || bookId.includes('/')) {
    return Response.json({ ok: false, error: 'bad_book_id' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as { state?: unknown } | null;
  const state = body?.state;
  const errors = validateSaveShape(state);
  if (errors.length > 0) {
    return Response.json({ ok: false, error: 'invalid_state', log: errors }, { status: 400 });
  }

  try {
    writeAdminBook(bookId, state as Parameters<typeof writeAdminBook>[1]);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: 'write_failed', log: [message] }, { status: 500 });
  }
}
