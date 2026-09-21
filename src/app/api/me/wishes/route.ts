// POST /api/me/wishes：不在册书的愿望（V0.2 A4，docs/02 §20.1）。
// 「我提到过这本书」→ 档案 wished_books 记一条 {title, at}：不许诺时间、不陈列、
// 只在提交后回显一次；读回靠数据导出（export 白名单显式带出）。
// 访客可记（首启发生在注册之前），注册时随游客迁移带走。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { appendWish, ensureProfile, saveWishes } from '@/lib/profile';
import { track } from '@/lib/analytics';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const identity = await resolveIdentity(request);
    const body = (await request.json().catch(() => ({}))) as { title?: unknown; locale?: unknown };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 100) return jsonError('invalid_title', 400);
    const locale = typeof body.locale === 'string' && body.locale ? body.locale : 'en';

    const profile = await ensureProfile(identity.key, locale);
    await saveWishes(identity.key, appendWish(profile.wished_books, title, new Date().toISOString()));
    // 埋点不带书名（P§9 日志纪律：用户输入的内容不进日志）
    await track(identity.key, 'book_wished', {}, profile.locale);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true, wished: true }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/me/wishes] failed:', error);
    return jsonError('server_error', 500);
  }
}
