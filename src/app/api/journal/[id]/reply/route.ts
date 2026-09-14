// POST /api/journal/[id]/reply：VIP 日记 AI 回应（付费墙②"日记写完想被回应时"，docs/02 §7）。
// 非 VIP → 403 {error:'vip_required'}（前端展示门禁文案，不弹窗）；
// safety_hit 的日记 → 转介文案作为回应（服务端定死，不走 LLM）；
// 已回应过 → 原样返回（幂等，不重复消耗 LLM）。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getJournalEntry, saveJournalReply, buildJournalReplySystem } from '@/lib/journal';
import { referralMessage } from '@/lib/safety';
import { getQuotaStatus, clientIpFromHeaders, guestKeyForRequest, GUEST_ID_COOKIE } from '@/lib/quota';
import { timeZoneFrom, todayIn } from '@/lib/time';
import { getLlmProviders, llmComplete } from '@/lib/llm';
import { isLocale, enabledLocales, type Locale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const entryId = Number(id);
    if (!Number.isInteger(entryId) || entryId <= 0) return jsonError('invalid_entry', 400);

    const identity = await resolveIdentity(request);
    const entry = await getJournalEntry(identity.key, entryId);
    if (!entry) return jsonError('entry_not_found', 404);

    // 已回应：幂等返回，不重复生成
    if (entry.aiReply) {
      return new Response(JSON.stringify({ reply: entry.aiReply, cached: true }), {
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
      });
    }

    const locale: Locale = isLocale(entry.locale) && enabledLocales.includes(entry.locale) ? entry.locale : 'en';

    // 危机命中的日记：回应 = 转介文案（危机陪伴永远免费，也不该由 LLM 即兴发挥）
    if (entry.safetyHit) {
      const reply = referralMessage(locale, 'crisis');
      await saveJournalReply(identity.key, entryId, reply);
      return new Response(JSON.stringify({ reply, safety: true }), {
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
      });
    }

    // 日界线按用户所在时区，不按服务器：游客 key 与配额桶都得用同一个「今天」

    const today = todayIn(timeZoneFrom(request.cookies));

    const guest = guestKeyForRequest(
      request.cookies.get(GUEST_ID_COOKIE)?.value,
      clientIpFromHeaders(request.headers),
      today
    );
    const status = await getQuotaStatus({ userId: identity.userId, guestKey: guest.guestKey, day: today });
    if (!status.isVip) {
      return new Response(JSON.stringify({ error: 'vip_required' }), {
        status: 403,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
      });
    }
    if (getLlmProviders().length === 0) return jsonError('llm_not_configured', 503);

    const reply = (
      await llmComplete({
        system: buildJournalReplySystem(locale, timeZoneFrom(request.cookies)),
        messages: [{ role: 'user', content: entry.content }],
        maxTokens: 500,
        temperature: 0.7,
      })
    ).trim();
    if (!reply) return jsonError('reply_failed', 502);

    await saveJournalReply(identity.key, entryId, reply);
    return new Response(JSON.stringify({ reply }), {
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/journal/reply] failed:', error);
    return jsonError('server_error', 500);
  }
}
