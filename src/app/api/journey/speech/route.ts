// POST /api/journey/speech —— 「按一下说」的转写入口（V0.2 批 D，docs/02 §20.4）。
//
// 职责只有一件：音频进、文字出。**不落库、不分析、不建标签、不记内容**——
// 转写文本回到「合」的输入框，由用户编辑后走 POST /api/journey/close 的既有
// 提交路径：安全层（P§8）在那里把关，转写入口不绕过也不抢跑（D2 判据：
// 「确认新入口没绕过安全层」——文本在 close 提交时才成为用户的话）。
//
// 音频只在本请求内存中存在，响应返回即弃（产品边界：转写完成即弃音频、
// 只留可删文字）。埋点只记字节数与 provider（P§9：不带转写文本）。
import { NextRequest } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { SttHttpError, SttNotConfiguredError, STT_MAX_BYTES, getSttProviders, transcribe } from '@/lib/stt';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // 与 /api/journey/close 同闸（「合」页只有登录用户能到）
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;
    const identity = auth.identity;

    const form = await request.formData().catch(() => null);
    const file = form?.get('audio');
    if (!(file instanceof File) || file.size === 0) return jsonError('bad_audio', 400);
    if (file.size > STT_MAX_BYTES) return jsonError('audio_too_large', 413);
    const localeBody = form?.get('locale');
    const locale = typeof localeBody === 'string' && isLocale(localeBody) && enabledLocales.includes(localeBody) ? localeBody : 'en';

    if (getSttProviders().length === 0) return jsonError('stt_not_configured', 501);

    const text = await transcribe(file, { filename: file.name || 'audio.webm', callPurpose: 'journey.speech' });
    await track(identity.key, 'speech_transcribed', { bytes: file.size }, locale);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true, text }), { headers });
  } catch (error) {
    if (error instanceof SttNotConfiguredError) return jsonError('stt_not_configured', 501);
    const status = error instanceof SttHttpError ? error.status : 0;
    if (status === 429) return jsonError('stt_rate_limited', 429);
    console.error('[api/journey/speech] failed:', error);
    return jsonError('stt_failed', 502);
  }
}
