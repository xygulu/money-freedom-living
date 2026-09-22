// 后台新建书（输入书名即可，V0.2 批 C4 后续）：书名必填，其余可选。
// 识别闸（用户 2026-09-22 拍板「输入书名自动生成，除非 AI 找不到该书本」）：
// 默认先 recognizeBook——AI 不认识 → 422 拒建（提示补作者或勾选自编/小众）；
// 认识 → 建骨架并让前端跳工作台（autodraft 只触发识别探针弹确认卡，
// 管理员确认后才真正生成——2026-09-23 确认闸）。
// skipUnknownCheck=true（自编/小众书）→ 跳过识别只建骨架，且不自动生成
// （AI 不认识的书自动生成只会产出通用内容——那正是要避免的）。
import { requireApiAdmin } from '@/lib/admin-auth';
import { BOOKS_DIR, readAdminBook } from '@/lib/admin-content';
import { recognizeBook } from '@/lib/admin-recognize';
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
    skipUnknownCheck?: boolean;
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

  // 识别闸：AI 不认识的书不建、不生成（fail-open 只在识别服务本身坏时发生）。
  // 2026-09-23 确认闸：这里的闸只挡「建书」这半步；真正的生成确认在工作台确认卡。
  const skipUnknownCheck = body?.skipUnknownCheck === true;
  if (!skipUnknownCheck) {
    const rec = await recognizeBook(titleZh, String(body?.author ?? '').trim(), gate.email);
    if (!rec.known) {
      return Response.json(
        {
          ok: false,
          error: 'book_unknown',
          recognition: rec,
          log: [
            `AI 不认识《${titleZh}》${rec.note ? `：${rec.note}` : ''}——拒绝凭空生成。`,
            '补上作者名（帮 AI 对上书）再点一次；或：① 核对书名重试；② 勾选「自编/小众书」只建骨架，之后在素材框贴要点再起草。',
          ],
        },
        { status: 422 },
      );
    }
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

  return Response.json({ ok: true, bookId, autodraft: !skipUnknownCheck });
}
