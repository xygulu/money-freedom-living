// POST /api/me/books：选书落库（V0.2 A3，docs/02 §20.1）。
// 身份用 resolveIdentity 而不是 requireApiUser（登录闸）：选书发生在首启（echo 之后的
// 选书屏），那时用户多半还没注册——g: 游客档案照样写，注册时随游客迁移带走。
// 目标书 active、其余 paused（mergeBookSelection 纯函数）；draft 书不可选。
// V0.2 B1/B2：body 可带 focusTopic（「读完它最想先弄明白的事」）——必须是合法命题
// 且属于这本书（选项来自本书 topics）；带焦点时埋点记 focus_topic_set（与选书分开算）。
import { NextRequest } from 'next/server';
import { TOPICS, getBook, type TopicId } from '@/lib/content';
import { resolveIdentity } from '@/lib/identity';
import { ensureProfile, mergeBookSelection, saveBooks } from '@/lib/profile';
import { track } from '@/lib/analytics';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const identity = await resolveIdentity(request);
    const body = (await request.json().catch(() => ({}))) as { bookId?: unknown; locale?: unknown; focusTopic?: unknown };
    const bookId = typeof body.bookId === 'string' ? body.bookId.trim() : '';
    const book = bookId ? getBook(bookId) : null;
    if (!book || book.status !== 'active') return jsonError('unknown_book', 400);
    const locale = typeof body.locale === 'string' && body.locale ? body.locale : 'en';

    let focusTopic: TopicId | undefined;
    if (body.focusTopic !== undefined && body.focusTopic !== null) {
      if (typeof body.focusTopic !== 'string' || !TOPICS.includes(body.focusTopic as TopicId)) {
        return jsonError('invalid_topic', 400);
      }
      const topic = body.focusTopic as TopicId;
      if (!book.topics.includes(topic)) return jsonError('invalid_topic', 400); // 选项来自本书 topics
      focusTopic = topic;
    }

    const profile = await ensureProfile(identity.key, locale);
    await saveBooks(identity.key, mergeBookSelection(profile.books, bookId, new Date().toISOString(), focusTopic));
    await track(
      identity.key,
      focusTopic ? 'focus_topic_set' : 'book_selected',
      focusTopic ? { bookId, topic: focusTopic } : { bookId },
      profile.locale,
    );

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true, bookId, ...(focusTopic ? { focusTopic } : {}) }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/me/books] failed:', error);
    return jsonError('server_error', 500);
  }
}
