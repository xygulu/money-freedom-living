// POST /api/onboarding/talk：创建体检初谈会话并流式产出 AI 开场。
// 初谈是首次流程的一部分，永不占配额（P§7）。触发 LLM 的首条 user 消息
// 只用于调用、不落库（聊天记录里只有 AI 追问与用户回答）。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getProfile } from '@/lib/profile';
import { createSession, appendMessage } from '@/lib/chat';
import { buildTalkSystem } from '@/lib/onboarding';
import { timeZoneFrom } from '@/lib/time';
import { llmStream } from '@/lib/llm';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError, sseResponse } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const OPENING_TRIGGER =
  '(The user has just submitted the questionnaire. Please begin the conversation with your first sentence according to the "first-round" rule in the initial conversation rules.)';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { locale?: string };
    const locale = body.locale;
    if (!isLocale(locale) || !enabledLocales.includes(locale)) return jsonError('invalid_locale', 400);

    const identity = await resolveIdentity(request);
    const profile = await getProfile(identity.key);
    const questionnaire = profile?.portrait?.questionnaire;
    if (!questionnaire || Object.keys(questionnaire).length === 0) {
      return jsonError('questionnaire_required', 400);
    }

    const session = await createSession({ userKey: identity.key, locale, kind: 'onboarding_talk' });
    const system = buildTalkSystem(locale, questionnaire, timeZoneFrom(request.cookies));

    async function* events() {
      yield { session: session.id };
      let full = '';
      for await (const delta of llmStream({ system, messages: [{ role: 'user', content: OPENING_TRIGGER }], maxTokens: 512 })) {
        full += delta;
        yield { delta };
      }
      if (full.trim()) await appendMessage(session.id, 'assistant', full.trim());
    }

    const response = sseResponse(events());
    if (identity.newGuestCookie) response.headers.set('Set-Cookie', identity.newGuestCookie);
    return response;
  } catch (error) {
    console.error('[api/onboarding/talk] failed:', error);
    return jsonError('server_error', 500);
  }
}
