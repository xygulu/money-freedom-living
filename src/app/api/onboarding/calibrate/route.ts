// POST /api/onboarding/calibrate：画像校准写回（说中了 / 不太像 + 可选修正）。
// 「不太像」的内容 AI 不再使用（script.rejected / 条目删除或替换）——docs/02 §2⑤。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getProfile, savePortrait } from '@/lib/profile';
import { applyCalibration, parseCalibrateSection } from '@/lib/onboarding';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      section?: string;
      verdict?: string;
      correction?: string;
    };
    const section = body.section ? parseCalibrateSection(body.section) : null;
    if (!section) return jsonError('invalid_section', 400);
    if (body.verdict !== 'hit' && body.verdict !== 'miss') return jsonError('invalid_verdict', 400);

    const identity = await resolveIdentity(request);
    const profile = await getProfile(identity.key);
    if (!profile?.portrait) return jsonError('portrait_not_found', 404);

    const next = applyCalibration(profile.portrait, section, body.verdict, body.correction);
    if (!next) return jsonError('calibration_requires_correction', 400);
    await savePortrait(identity.key, next);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ portrait: next }), { headers: { ...headers, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[api/onboarding/calibrate] failed:', error);
    return jsonError('server_error', 500);
  }
}
