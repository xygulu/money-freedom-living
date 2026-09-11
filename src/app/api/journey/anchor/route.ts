// POST /api/journey/anchor：设置/清除周期情绪锚点（发薪日节奏，docs/02 §5）。
// 默认不猜：不设置就不显示锚点。锚点只在锚点日被动呈现一句感知文案。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import { ensureProfile, savePayday } from '@/lib/profile';
import { parsePaydayInput } from '@/lib/anchor';
import { track } from '@/lib/analytics';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { payday?: unknown };
    const payday = parsePaydayInput(body.payday);
    if (payday === undefined) return jsonError('invalid_payday', 400);

    const identity = await resolveIdentity(request);
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
