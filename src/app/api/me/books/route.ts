// POST /api/me/books：选书落库（V0.2 A3，docs/02 §20.1）。
// 身份用 resolveIdentity 而不是 requireApiUser（登录闸）：选书发生在首启（echo 之后的
// 选书屏），那时用户多半还没注册——g: 游客档案照样写，注册时随游客迁移带走。
// 目标书 active、其余 paused（mergeBookSelection 纯函数）；draft 书不可选。
import { NextRequest } from 'next/server';
import { getBook } from '@/lib/content';
import { resolveIdentity } from '@/lib/identity';
import { ensureProfile, mergeBookSelection, saveBooks } from '@/lib/profile';
import { track } from '@/lib/analytics';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const identity = await resolveIdentity(request);
    const body = (await request.json().catch(() => ({}))) as { bookId?: unknown; locale?: unknown };
    const bookId = typeof body.bookId === 'string' ? body.bookId.trim() : '';
    const book = bookId ? getBook(bookId) : null;
    if (!book || book.status !== 'active') return jsonError('unknown_book', 400);
    const locale = typeof body.locale === 'string' && body.locale ? body.locale : 'en';

    const profile = await ensureProfile(identity.key, locale);
    await saveBooks(identity.key, mergeBookSelection(profile.books, bookId, new Date().toISOString()));
    await track(identity.key, 'book_selected', { bookId }, profile.locale);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true, bookId }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/me/books] failed:', error);
    return jsonError('server_error', 500);
  }
}
