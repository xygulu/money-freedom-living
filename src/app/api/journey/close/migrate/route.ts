// POST /api/journey/close/migrate —— L4 迁移：**用户亲手确认**「这是新的，记下来」。
// DELETE 同一路径 —— 「不对，撤销」：**真删**那条证据，不留痕（docs/10 P0-1）。
//
// 为什么记与不记都得经过用户的手：让用户自己判断"这算不算迁移"＝把测量负担推给他，
// 且不可靠；让 AI 直接记＝背着人贴标签，踩「不诊断、不贴标签」的红线。
// 只有"AI 提议、用户确认、随时可撤"这一条路两边都不踩。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { activeBookId, deleteThreadEvidence, getProfile, recordThreadEvidence } from '@/lib/profile';
import { FIRST_LINE_MAX } from '@/lib/cognition';
import { TOPICS, type TopicId } from '@/lib/content';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale, type Locale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

function parseTopic(v: unknown): TopicId | null {
  return typeof v === 'string' && (TOPICS as readonly string[]).includes(v) ? (v as TopicId) : null;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { topic?: string; quote?: string; locale?: string };
    const topic = parseTopic(body.topic);
    const quote = typeof body.quote === 'string' ? body.quote.trim().slice(0, FIRST_LINE_MAX) : '';
    if (!topic || !quote) return jsonError('bad_request', 400);
    const locale: Locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';

    const identity = await resolveIdentity(request);
    const profile = await getProfile(identity.key);
    if (!profile) return jsonError('no_profile', 404);

    const at = new Date().toISOString();
    // 迁移＝旧脚本真的被换过一次，所以这条线上的程度记 replaced（只增不减由 mergeDepth 兜）
    await recordThreadEvidence(
      identity.key,
      topic,
      { at, bookId: activeBookId(profile), source: 'close', quote, kind: 'migrate' },
      profile.threads?.[topic],
      'replaced'
    );
    await track(identity.key, 'cognition_migrate_kept', { topic }, locale);
    return Response.json({ ok: true, at }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[api/journey/close/migrate] failed:', error);
    return jsonError('server_error', 500);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const topic = parseTopic(url.searchParams.get('topic'));
    const at = url.searchParams.get('at') ?? '';
    if (!topic || !at) return jsonError('bad_request', 400);
    const locale = url.searchParams.get('locale') ?? undefined;

    const identity = await resolveIdentity(request);
    await deleteThreadEvidence(identity.key, topic, at);
    await track(identity.key, 'cognition_migrate_undone', { topic }, locale ?? undefined);
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[api/journey/close/migrate] delete failed:', error);
    return jsonError('server_error', 500);
  }
}
