// POST /api/journey/advance：阶段推进（M9 需求③）。
// AI 提议 + 用户确认的确认动作落在这里；服务端复算 canAdvance 防绕 UI 直刷。
// 无 LLM；推进即仪式：stage+1、stage_started_at 重置、心印 stage{n}_entered。
// 「先留在这里」不走这里（纯前端收起）——尊重节奏不设惩罚。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getProfile, saveStage, appendStamps } from '@/lib/profile';
import { computeStageProgress, MAX_STAGE } from '@/lib/stage';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { locale?: string };
    const locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';

    const identity = await resolveIdentity(request);
    const profile = await getProfile(identity.key);
    if (!profile) return jsonError('profile_not_found', 404);

    const from = profile.stage;
    if (from >= MAX_STAGE) return jsonError('no_next_stage', 400);
    // 防绕过：不复算 UI 就展示不了卡，但 API 直刷必须过同一道判定
    if (!computeStageProgress(from, profile).canAdvance) return jsonError('advance_not_ready', 403);

    const to = from + 1;
    await saveStage(identity.key, to);
    await appendStamps(identity.key, [`stage${to}_entered`]);
    await track(identity.key, 'stage_advanced', { from: String(from), to: String(to) }, locale);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return Response.json({ stage: to }, { headers });
  } catch (error) {
    console.error('[api/journey/advance] failed:', error);
    return jsonError('server_error', 500);
  }
}
