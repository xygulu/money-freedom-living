// POST /api/onboarding/portrait：画像生成（问卷 + 初谈素材 → 四段画像）→ 落库。
// 结构不合法重试一次；仍失败返回 502——禁止编造默认画像（docs/02 §2② 红线）。
// 完成即计一次活跃足迹（docs/02 §11：体检完成属于活跃动作）。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getProfile, savePortrait, bumpActiveDay, type Portrait } from '@/lib/profile';
import { getSession, getSessionMessages, closeSession } from '@/lib/chat';
import { buildPortraitMessages, validatePortraitDraft } from '@/lib/onboarding';
import { insertPortraitVersion } from '@/lib/evolution';
import { llmCompleteJson } from '@/lib/llm';
import { recordConsent, hashIp } from '@/lib/consent';
import { track } from '@/lib/analytics';
import { clientIpFromHeaders } from '@/lib/quota';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({})) ) as {
      locale?: string;
      sessionId?: string;
      consent?: boolean;
    };
    const locale = body.locale;
    if (!isLocale(locale) || !enabledLocales.includes(locale)) return jsonError('invalid_locale', 400);

    // 敏感信息单独同意（P§9）：服务端强校验，勾选记录带时间戳/IP 哈希/政策版本入库
    //（游客同样记录）；拒绝者可继续用问卷与日记，只是走到这里会被拦下
    if (body.consent !== true) return jsonError('consent_required', 400);

    const identity = await resolveIdentity(request);
    const profile = await getProfile(identity.key);
    const questionnaire = profile?.portrait?.questionnaire;
    if (!questionnaire || Object.keys(questionnaire).length === 0) return jsonError('questionnaire_required', 400);

    let chatText = '';
    if (body.sessionId) {
      const session = await getSession(body.sessionId);
      if (session && session.userKey === identity.key) {
        chatText = (await getSessionMessages(body.sessionId))
          .map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.content}`)
          .join('\n\n');
        await closeSession(body.sessionId);
      }
    }

    const { system, messages } = buildPortraitMessages(locale, questionnaire, chatText);

    let draft = validatePortraitDraft(await llmCompleteJson({ system, messages, maxTokens: 2000 }));
    if (!draft) {
      console.warn('[api/onboarding/portrait] first draft invalid, retrying once');
      draft = validatePortraitDraft(await llmCompleteJson({ system, messages, maxTokens: 2000 }));
    }
    if (!draft) return jsonError('portrait_generation_failed', 502);

    const portrait: Portrait = {
      questionnaire,
      spoken: draft.spoken,
      baseColor: draft.baseColor,
      moments: draft.moments,
      script: draft.script,
      toFuture: draft.toFuture,
      version: 1,
      calibrations: [],
      scriptStatus: 'pending',
    };
    await savePortrait(identity.key, portrait);
    // v1 快照入版本表（时间线画像节点 + 演进基线用）。best-effort：失败不拦画像，
    // 首次演进时有懒回填兜底
    try {
      await insertPortraitVersion(identity.key, 1, portrait, 'onboarding');
    } catch (error) {
      console.error('[api/onboarding/portrait] insert v1 snapshot failed:', error);
    }
    await bumpActiveDay(identity.key);
    await recordConsent(identity.key, true, hashIp(clientIpFromHeaders(request.headers)));
    // 验收指标：体检完成率分子（docs/02 §11）
    await track(identity.key, 'portrait_done', {}, locale);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ portrait }), { headers: { ...headers, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[api/onboarding/portrait] failed:', error);
    return jsonError('server_error', 500);
  }
}
