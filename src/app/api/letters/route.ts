// /api/letters：信件基础闭环（写/存/AI 回信/封存开启简版，docs/02 MVP 范围）。
// POST = 写信：安全层筛查（回信前覆盖点）→ 命中则回信=转介文案（不走 LLM）→
//        存入档案 letters[]（state='kept' 留着）→ 计活跃足迹。回信对所有档位免费。
// PATCH = 状态流转（kept 封存→sealed，sealed 开启→opened；仅允许这两个方向）。
import { NextRequest } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { appendLetter, bumpActiveDay, ensureProfile, getProfile, setLetterState, type LetterEntry } from '@/lib/profile';
import { buildLetterReplySystem } from '@/lib/letters';
import { checkSafety, recordSafetyEvent, referralMessage } from '@/lib/safety';
import { track } from '@/lib/analytics';
import { getLlmProviders, llmComplete } from '@/lib/llm';
import { enabledLocales, isLocale, type Locale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CONTENT_MAX = 3000;

export async function POST(request: NextRequest) {
  try {
    // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;
    const identity = auth.identity;

    const body = (await request.json().catch(() => ({}))) as { content?: string; locale?: string };
    const content = typeof body.content === 'string' ? body.content.trim().slice(0, CONTENT_MAX) : '';
    if (!content) return jsonError('empty_content', 400);
    const locale: Locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';
    const profile = await ensureProfile(identity.key, locale);

    const verdict = await checkSafety(locale, content);
    if (verdict.hit) await recordSafetyEvent(identity.key, 'letter', verdict.category ?? 'crisis');

    let aiReply: string | null = null;
    if (verdict.hit) {
      // 危机命中：回信 = 转介文案（服务端定死；信本身照常收着——它是用户的真实处境）
      aiReply = referralMessage(locale, verdict.category ?? 'crisis');
    } else if (getLlmProviders().length > 0) {
      const raw = await llmComplete({
        system: buildLetterReplySystem(locale),
        messages: [{ role: 'user', content: content }],
        maxTokens: 400,
        temperature: 0.7,
      });
      aiReply = raw.trim() || null; // 回信失败不阻塞收信：信先存下，回信为空（MVP 不补投递）
    }

    // createdAt 用服务端时间：客户端乐观插入的条目必须与库中键一致（PATCH 按 createdAt 定位）
    const letter: LetterEntry = {
      stage: profile.stage,
      content,
      state: 'kept',
      aiReply,
      createdAt: new Date().toISOString(),
    };
    await appendLetter(identity.key, letter);
    try {
      await bumpActiveDay(identity.key);
    } catch (error) {
      console.error('[api/letters] bumpActiveDay failed:', error);
    }
    await track(identity.key, 'letter_sent', { safety: verdict.hit }, locale);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ safety: verdict.hit, letter }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/letters] failed:', error);
    return jsonError('server_error', 500);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;
    const identity = auth.identity;

    const body = (await request.json().catch(() => ({}))) as { createdAt?: string; action?: string };
    if (!body.createdAt) return jsonError('missing_letter', 400);
    // 简版只允许两个方向：封存（kept→sealed）、开启（sealed→opened）
    const next: LetterEntry['state'] | null =
      body.action === 'seal' ? 'sealed' : body.action === 'open' ? 'opened' : null;
    if (!next) return jsonError('invalid_action', 400);
    const profile = await getProfile(identity.key);
    const letter = profile?.letters.find((l) => l.createdAt === body.createdAt);
    if (!letter) return jsonError('letter_not_found', 404);
    const allowed = (letter.state === 'kept' && next === 'sealed') || (letter.state === 'sealed' && next === 'opened');
    if (!allowed) return jsonError('invalid_transition', 409);

    await setLetterState(identity.key, body.createdAt, next);
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true, state: next }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/letters] patch failed:', error);
    return jsonError('server_error', 500);
  }
}
