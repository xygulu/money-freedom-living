// POST /api/onboarding/talk：创建体检初谈会话并流式产出 AI 开场。
// 初谈是首次流程的一部分，永不占配额（P§7）。触发 LLM 的首条 user 消息
// 只用于调用、不落库（聊天记录里只有 AI 追问与用户回答）。
//
// 首启重排 v2（2026-09-17）：talk 在新流程下也可在画像完成后由 echo 步 CTA
// 触发（"想多聊聊？"）—— 形成 onboarding_talk session，进入 talk 步的深度对话。
// 这两个入口都复用本接口；问卷**可以**已交（画像生成后再聊），所以这里不强制
// questionnaire 必填——开场纪律根据 questionnaire 是否为空走不同分支（见 buildTalkSystem）。
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
  '(Please begin the conversation with your first sentence, following the "first-round" rule in the initial conversation rules.)';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { locale?: string };
    const locale = body.locale;
    if (!isLocale(locale) || !enabledLocales.includes(locale)) return jsonError('invalid_locale', 400);

    const identity = await resolveIdentity(request);
    const profile = await getProfile(identity.key);
    // 问卷可能还没开始（首启就是一段对话）——没有就不给，不是错误
    const questionnaire = profile?.portrait?.questionnaire ?? {};

    const session = await createSession({ userKey: identity.key, locale, kind: 'onboarding_talk' });
    const system = buildTalkSystem(locale, questionnaire, timeZoneFrom(request.cookies));

    async function* events() {
      yield { session: session.id };
      let full = '';
      for await (const chunk of llmStream({
        system,
        messages: [{ role: 'user', content: OPENING_TRIGGER }],
        maxTokens: 512,
        callId: `onboarding:${session.id}`,
        callPurpose: 'onboarding.talk',
        userKey: identity.key,
      })) {
        if (typeof chunk === 'string') {
          full += chunk;
          yield { delta: chunk };
        } else {
          yield {
            providerSwitch: {
              from: chunk.from,
              to: chunk.to,
              reason: chunk.reason,
              chunksYielded: chunk.chunksYielded,
            },
          };
        }
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
