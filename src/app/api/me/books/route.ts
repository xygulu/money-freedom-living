// POST /api/me/books：选书/加书落库（V0.2 A3，docs/02 §20.1；汇入制 V0.2 批 C）。
// 身份用 resolveIdentity 而不是 requireApiUser（登录闸）：选书发生在首启（echo 之后的
// 选书屏），那时用户多半还没注册——g: 游客档案照样写，注册时随游客迁移带走。
// mode（缺省 'select'）：
// - 'select'（首启向导发）→ mergeBookSelection：目标书 active、其余 paused（替换制）。
// - 'add'（旅程页入口发）→ addBookSelection：目标书 active、**其余条目一字不碰**（汇入制）。
//   首启绝不能发 add——parseBooks 会给每个档案合成一条 v1 书的 active 条目，纯加法会
//   把「选了 B 书」变成「v1 与 B 双 active」，静默换掉路线图。
// draft 书不可选；不可见的书同样按 unknown_book 拒（红线 1：不陈列还没上线的书）。
// V0.2 B1/B2：body 可带 focusTopic（「读完它最想先弄明白的事」）——必须是合法命题
// 且属于这本书（选项来自本书 topics）；带焦点时埋点记 focus_topic_set（与选书分开算）。
// 埋点：select 记 book_selected（带焦点时改记 focus_topic_set）；add 记 book_added。
import { NextRequest } from 'next/server';
import { TOPICS, getBook, type TopicId } from '@/lib/content';
import { resolveIdentity } from '@/lib/identity';
import { addBookSelection, activeBookId, ensureProfile, mergeBookSelection, saveBooks } from '@/lib/profile';
import { insertPortraitVersion, nextPortraitVersion } from '@/lib/evolution';
import { track } from '@/lib/analytics';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const identity = await resolveIdentity(request);
    const body = (await request.json().catch(() => ({}))) as { bookId?: unknown; locale?: unknown; focusTopic?: unknown; mode?: unknown };
    const bookId = typeof body.bookId === 'string' ? body.bookId.trim() : '';
    const book = bookId ? getBook(bookId) : null;
    if (!book || book.status !== 'active') return jsonError('unknown_book', 400);
    const locale = typeof body.locale === 'string' && body.locale ? body.locale : 'en';
    const mode = body.mode === 'add' ? 'add' : 'select';

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
    const nowISO = new Date().toISOString();
    const books =
      mode === 'add'
        ? addBookSelection(profile.books, bookId, nowISO, focusTopic)
        : mergeBookSelection(profile.books, bookId, nowISO, focusTopic);

    // 换书快照（C5，2026-11-13）：select 模式真的换了主线书且已有画像时，先把当前
    // 画像存一版 source='book_switch'、book_id 归**出走的书**——换书场景的画像版本
    // 归属从此可区分（docs/02 §10.6 登记的缺口）。best-effort：快照失败不拦选书。
    const outgoing = activeBookId(profile);
    if (mode === 'select' && outgoing !== bookId && profile.portrait) {
      try {
        const nextVersion = await nextPortraitVersion(identity.key);
        await insertPortraitVersion(
          identity.key,
          nextVersion,
          profile.portrait,
          'book_switch',
          { from: outgoing, to: bookId },
          outgoing,
        );
      } catch (error) {
        console.error('[api/me/books] book_switch portrait snapshot failed:', error);
      }
    }

    await saveBooks(identity.key, books);
    if (mode === 'add') {
      await track(identity.key, 'book_added', { bookId, ...(focusTopic ? { topic: focusTopic } : {}) }, profile.locale);
    } else {
      await track(
        identity.key,
        focusTopic ? 'focus_topic_set' : 'book_selected',
        focusTopic ? { bookId, topic: focusTopic } : { bookId },
        profile.locale,
      );
    }

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true, bookId, mode, ...(focusTopic ? { focusTopic } : {}) }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/me/books] failed:', error);
    return jsonError('server_error', 500);
  }
}
