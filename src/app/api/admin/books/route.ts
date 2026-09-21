// 后台新建书（输入书名即可，V0.2 批 C4 后续）：书名必填，其余可选——
// bookId 缺省自动生成，作者/出处/素材空着就先落 TODO，跳工作台 AI 起草再校正。
// 只建骨架（status: draft），不触线上；发布仍走 PublishButton 的 C2/C3 闸。
import { requireApiAdmin } from '@/lib/admin-auth';
import { BOOKS_DIR, readAdminBook } from '@/lib/admin-content';
import { createBookSkeleton, isValidBookId, suggestBookId } from '@/lib/admin-scaffold';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function POST(request: Request) {
  const gate = await requireApiAdmin();
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as {
    bookId?: string;
    titleZh?: string;
    titleEn?: string;
    author?: string;
    source?: string;
  } | null;

  const titleZh = String(body?.titleZh ?? '').trim();
  if (!titleZh) {
    return Response.json({ ok: false, error: 'title_required', log: ['书名（zh-CN）必填。'] }, { status: 400 });
  }

  // bookId：给了就校验 kebab-case；没给自动生成（book-<base36>）
  let bookId = String(body?.bookId ?? '').trim();
  if (bookId) {
    if (!isValidBookId(bookId)) {
      return Response.json(
        { ok: false, error: 'bad_book_id', log: ['bookId 必须是 kebab-case（小写字母/数字/连字符）。'] },
        { status: 400 },
      );
    }
  } else {
    bookId = suggestBookId();
  }

  if (existsSync(join(BOOKS_DIR, bookId)) || readAdminBook(bookId)) {
    return Response.json({ ok: false, error: 'book_exists', log: [`已存在：${bookId}——不覆盖，换个 id 或直接进工作台。`] }, { status: 409 });
  }

  try {
    createBookSkeleton({
      bookId,
      titleZh,
      titleEn: typeof body?.titleEn === 'string' ? body.titleEn : undefined,
      author: typeof body?.author === 'string' ? body.author : undefined,
      source: typeof body?.source === 'string' ? body.source : undefined,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith('book_exists')) {
      return Response.json({ ok: false, error: 'book_exists', log: [msg] }, { status: 409 });
    }
    console.error('[api/admin/books] scaffold failed:', error);
    return Response.json({ ok: false, error: 'scaffold_failed', log: [msg] }, { status: 500 });
  }

  return Response.json({ ok: true, bookId });
}
