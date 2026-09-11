// POST /api/onboarding/calibrate：画像校准写回（说中了 / 不太像 + 可选修正）。
// 「不太像」的内容 AI 不再使用（script.rejected / 条目删除或替换）——docs/02 §2⑤。
// 修正文本也是用户文本入口：先过安全层（P§8 全入口覆盖），命中落事件 + 响应带提示。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { getProfile, savePortrait } from '@/lib/profile';
import { applyCalibration, parseCalibrateSection } from '@/lib/onboarding';
import { checkSafety, recordSafetyEvent } from '@/lib/safety';
import { track } from '@/lib/analytics';
import { enabledLocales, isLocale, type Locale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      section?: string;
      verdict?: string;
      correction?: string;
      locale?: string;
    };
    const section = body.section ? parseCalibrateSection(body.section) : null;
    if (!section) return jsonError('invalid_section', 400);
    if (body.verdict !== 'hit' && body.verdict !== 'miss') return jsonError('invalid_verdict', 400);
    const locale: Locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';

    const identity = await resolveIdentity(request);
    const profile = await getProfile(identity.key);
    if (!profile?.portrait) return jsonError('portrait_not_found', 404);

    // 入口安全层：修正文本可能带着真实处境来（"不太像，其实是……我老公摔了我的卡"）。
    // 命中 → 落事件；校准本身照常写回（用户的话就是用户的话），响应带 safety 提示供 UI 转介。
    let safetyHit = false;
    if (body.correction?.trim()) {
      const verdict = await checkSafety(locale, body.correction);
      if (verdict.hit) {
        safetyHit = true;
        await recordSafetyEvent(identity.key, 'calibrate', verdict.category ?? 'crisis');
      }
    }

    const next = applyCalibration(profile.portrait, section, body.verdict, body.correction);
    // 验收指标：说中率分母分子（docs/02 §11）
    await track(identity.key, 'calibrate', { verdict: body.verdict, section });
    if (!next) return jsonError('calibration_requires_correction', 400);
    await savePortrait(identity.key, next);

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ portrait: next, safety: safetyHit }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/onboarding/calibrate] failed:', error);
    return jsonError('server_error', 500);
  }
}
