// POST /api/chat/[sessionId]：向会话发消息，流式拿回复。
// M3 服务 onboarding_talk（初谈）；M4 的正式对话（kind=chat）走配额落账后复用本通道。
// silent 消息只入库不生成回复（「我听到的是」确认步的用户补充）。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import { getSession, getSessionMessages, appendMessage, closeSession, TALK_MAX_USER_MESSAGES } from '@/lib/chat';
import { buildTalkSystem } from '@/lib/onboarding';
import { llmStream } from '@/lib/llm';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError, sseResponse } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MESSAGE_MAX = 2000;

export async function POST(request: NextRequest, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as { message?: string; silent?: boolean };
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, MESSAGE_MAX) : '';
    if (!message) return jsonError('empty_message', 400);

    const identity = await resolveIdentity(request);
    const session = await getSession(sessionId);
    if (!session || session.userKey !== identity.key) return jsonError('session_not_found', 404);
    if (session.status !== 'open') return jsonError('session_closed', 409);
    if (session.kind !== 'onboarding_talk') return jsonError('kind_not_supported_yet', 400);

    const userTurns = (await getSessionMessages(sessionId)).filter((m) => m.role === 'user').length;
    if (userTurns >= TALK_MAX_USER_MESSAGES) return jsonError('talk_limit_reached', 409);

    const profile = await getProfile(identity.key);
    const questionnaire = profile?.portrait?.questionnaire;
    if (!questionnaire) return jsonError('questionnaire_required', 400);

    await appendMessage(sessionId, 'user', message);
    if (body.silent) {
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store', ...(identity.newGuestCookie ? { 'Set-Cookie': identity.newGuestCookie } : {}) },
      });
    }

    const history = await getSessionMessages(sessionId);
    const sessionLocale = isLocale(session.locale) && enabledLocales.includes(session.locale) ? session.locale : 'en';
    const system = buildTalkSystem(sessionLocale, questionnaire);

    async function* events() {
      yield { session: sessionId };
      let full = '';
      for await (const delta of llmStream({ system, messages: history, maxTokens: 512 })) {
        full += delta;
        yield { delta };
      }
      if (full.trim()) await appendMessage(sessionId, 'assistant', full.trim());
    }

    const response = sseResponse(events());
    if (identity.newGuestCookie) response.headers.set('Set-Cookie', identity.newGuestCookie);
    return response;
  } catch (error) {
    console.error('[api/chat/sessionId] failed:', error);
    return jsonError('server_error', 500);
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const identity = await resolveIdentity(request);
  const session = await getSession(sessionId);
  if (!session || session.userKey !== identity.key) return jsonError('session_not_found', 404);
  await closeSession(sessionId);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
