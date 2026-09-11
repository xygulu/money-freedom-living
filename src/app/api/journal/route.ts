// /api/journal：日记（金钱心事）。POST = 写/存（免费，所有用户），GET = 自己的日记列表。
// 写入即计活跃足迹（docs/02 §11：日记算当日动作之一）。
// 安全层（P§8 全入口覆盖）：写入时筛查，命中 → 落事件 + 条目标记 safety_hit
// （回应时直接转介文案，不再走 LLM）；日记本身照常保存——它记录的是用户的真实处境。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { bumpActiveDay, ensureProfile } from '@/lib/profile';
import { checkSafety, recordSafetyEvent } from '@/lib/safety';
import { track } from '@/lib/analytics';
import { getJournalEntries } from '@/lib/journal';
import { execWithFailover, ensureSchema } from '@/lib/db';
import { enabledLocales, isLocale, type Locale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

const CONTENT_MAX = 5000;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { content?: string; locale?: string };
    const content = typeof body.content === 'string' ? body.content.trim().slice(0, CONTENT_MAX) : '';
    if (!content) return jsonError('empty_content', 400);
    const locale: Locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';

    const identity = await resolveIdentity(request);

    const verdict = await checkSafety(locale, content);
    if (verdict.hit) await recordSafetyEvent(identity.key, 'journal', verdict.category ?? 'crisis');

    await ensureSchema();
    const rows = await execWithFailover((sql) =>
      sql`INSERT INTO journal_entries (user_key, locale, content, safety_hit)
          VALUES (${identity.key}, ${locale}, ${content}, ${verdict.hit})
          RETURNING id, created_at`
    );
    const entry = rows[0];

    // 对话本身就是建档动作：日记也可能写在体检之前（无档案行先建）
    await ensureProfile(identity.key, locale);
    try {
      await bumpActiveDay(identity.key);
    } catch (error) {
      console.error('[api/journal] bumpActiveDay failed:', error);
    }
    // 只存"写了一篇 + 是否命中危机"这类元数据，不含内容原文（P§9）
    await track(identity.key, 'journal_saved', { safety: verdict.hit }, locale);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(
      JSON.stringify({
        // BIGSERIAL 经 HTTP 驱动返回字符串，归一成 number 供前端用
        entry: { id: Number(entry.id), createdAt: entry.created_at },
        safety: verdict.hit,
      }),
      { headers: { ...headers, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[api/journal] failed:', error);
    return jsonError('server_error', 500);
  }
}

export async function GET(request: NextRequest) {
  try {
    const identity = await resolveIdentity(request);
    const entries = await getJournalEntries(identity.key);
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ entries }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/journal] list failed:', error);
    return jsonError('server_error', 500);
  }
}
