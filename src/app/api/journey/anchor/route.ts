// POST /api/journey/anchor：设置/清除周期情绪锚点（发薪日节奏，docs/02 §5）。
// 默认不猜：不设置就不显示锚点。锚点只在锚点日被动呈现一句感知文案。
import { NextRequest } from 'next/server';
import { requireApiUser } from '@/lib/api-auth';
import { ensureProfile, savePayday } from '@/lib/profile';
import { parsePaydayInput } from '@/lib/anchor';
import { track } from '@/lib/analytics';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // 访客闸（用户 2026-09-14 拍板：访客 = 只能做金钱关系测试）
    const auth = await requireApiUser();
    if (!auth.ok) return auth.response;
    const identity = auth.identity;

    const body = (await request.json().catch(() => ({}))) as { payday?: unknown };
    const payday = parsePaydayInput(body.payday);
    if (payday === undefined) return jsonError('invalid_payday', 400);
    await ensureProfile(identity.key, 'en');
    await savePayday(identity.key, payday);
    if (payday) await track(identity.key, 'anchor_set', { type: payday.type });

    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true, payday }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[api/journey/anchor] failed:', error);
    return jsonError('server_error', 500);
  }
}
