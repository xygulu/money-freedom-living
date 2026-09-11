// POST /api/onboarding/reflect：「我听到的是…」确认步（生成画像前的素材校验）。
// 3-5 句复述初谈要点，用户确认/补充。复述本身不入库——画像素材 = 会话记录 + 用户补充。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getSession, getSessionMessages } from '@/lib/chat';
import { buildReflectMessages } from '@/lib/onboarding';
import { llmComplete } from '@/lib/llm';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { sessionId?: string; locale?: string };
    const sessionId = body.sessionId;
    const locale = body.locale;
    if (!isLocale(locale) || !enabledLocales.includes(locale)) return jsonError('invalid_locale', 400);
    if (!sessionId) return jsonError('session_required', 400);

    const identity = await resolveIdentity(request);
    const session = await getSession(sessionId);
    if (!session || session.userKey !== identity.key) return jsonError('session_not_found', 404);

    const history = await getSessionMessages(sessionId);
    if (history.length === 0) return jsonError('empty_session', 400);

    const chatText = history.map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.content}`).join('\n\n');
    const { system, messages } = buildReflectMessages(locale, chatText);
    const summary = await llmComplete({ system, messages, maxTokens: 600 });

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ summary: summary.trim() }), { headers: { ...headers, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[api/onboarding/reflect] failed:', error);
    return jsonError('server_error', 500);
  }
}
